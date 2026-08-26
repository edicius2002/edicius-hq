"""
One collection pass over the watched routes.

Framework-free on purpose. The router calls it, `scripts/fares-collect.py`
calls it, and a scheduled job somewhere else would call it the same way — the
plan's runner decision is "local now, elsewhere later", and the way to keep
that cheap is to have the thing being run own no assumptions about who runs it.

Since 12.110 the unit the reader watches is a route and a *month*, while the
unit a provider answers about is still a route and a day. `collect_due` is
where those meet: it expands each watched month into its departures and hands
them to the same per-departure schedule that has always been here. Nothing
below that line knows a month exists.

Two properties this owes the caller:

**A refusal is reported, not swallowed.** Every route comes back with an
outcome, and a failed one carries its reason beside the ones that worked —
decisions 8.8 and 8.41. A collector that quietly skipped a route would look
identical to a route with no price change.

**Requests are spaced.** The upstream is unmetered and undocumented, which
makes pacing our responsibility rather than theirs. Sequential with a gap, not
concurrent: there is nothing to gain by going faster and an address to lose by
it.

**And they are counted, once each, against the day rather than the pass.** The
gap decides how tightly a day's requests are packed and not how many there are;
what decides how many is `fare_budget`, a ledger on disk that both passes below
spend from. Every request either function sends is written to it immediately
before it goes out, so a pass cannot spend without saying so and ninety-six
scheduled passes cannot each believe they have the whole budget.

**And a pass does not run twice at once.** Counting is not enough on its own:
two board passes starting together would each read a day with room in it and
each plan a whole day of work before either could see the other. Both entry
points below take a `PassLock` before they plan and hold it until they are done,
which also keeps the gap above meaning what it says — one loop pacing one
address, rather than two loops halving it. A pass that finds its lock held
declines and says so; it does not wait and it does not raise. The boards and the
calendar take **different** locks, because they are two slots on purpose and
`calendar_job` argues why.

**Every look leaves a mark; only a change leaves a snapshot.** Measured
2026-08-18, four of five real snapshots were byte-identical to the one before —
two of them taken 23 seconds and 8 minutes apart. Polling on the half hour and
writing every time would fill the archive with copies, so a snapshot is written
only when a price moved or a flight came or went, and a one-line heartbeat is
written always. A quiet week then reads as a quiet week rather than as a week
the collector was down.
"""

import asyncio
import logging
import os
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
from time import perf_counter
from typing import Protocol

import httpx

from app.adapters.fares.models import (
    CalendarPrice,
    CalendarQuery,
    FareError,
    FareQuery,
    FareSnapshot,
)
from app.adapters.fares.registry import (
    CALENDAR_RANGE_DAYS,
    DEFAULT_PROVIDER,
    fetch_calendar,
    fetch_search,
)
from app.config import (
    CALENDAR_POLL_MINUTES,
    DEFAULT_CADENCE_MINUTES,
    MAX_DEPARTURE_HORIZON_DAYS,
    UPSTREAM_TIMEOUT_SECONDS,
    daily_request_budget,
)
from app.services.fare_budget import (
    CALENDAR_LOCK_NAME,
    DailyBudget,
    PassLock,
    RequestLedger,
    daily_budget,
)
from app.services.fare_calendar import CALENDAR, CalendarCurve, FareCalendar
from app.services.fare_history import HISTORY, FareHistory
from app.services.fare_schedule import due_now, month_dates

logger = logging.getLogger(__name__)

# Seconds between upstream requests. Slow enough to look like a person browsing,
# fast enough that a twenty-route watchlist finishes in a couple of minutes.
#
# **Six until 12.211, and the six was never measured.** Timing a real pass put
# 86.5% of its wall clock inside this sleep: ten paced requests took 62.5s, of
# which 54.1s was here, 6.3s was the upstream and 0.03s was parsing. Sleeping
# *is* the cost of a manual retrieval; everything else is rounding.
#
# Three is what was measured rather than what was hoped for. Twelve requests at
# three seconds and twelve more at two came back clean — no 429, no consent
# redirect, no `ErrorResponse`, and mean latency that *fell* as the gap closed
# (0.630s at six, 0.421s at three, 0.394s at two) because a warm connection is
# the only thing the spacing was changing. A throttle looks like the opposite.
# Two was clean too and is deliberately not taken: three is the pace with the
# most evidence behind it, and leaving the measured floor unused is the margin.
#
# What this does **not** rest on is daily volume, which nobody here has probed.
# The saving grace is that it does not have to: the pace changes how tightly the
# day's requests are packed and not how many there are. A watchlist that spent
# 66 requests a day at six seconds spends the same 66 at three.
DEFAULT_REQUEST_GAP_SECONDS = 3.0


def _request_gap_seconds() -> float:
    """
    The paced gap, with an override for deliberately probing below the floor.

    The default stays at the measured 3.0 and is what every unset environment
    gets. `FARES_REQUEST_GAP_SECONDS` exists so that an experiment below the
    measured floor lives in the thing that launches the collector rather than
    in this file: unset the variable and the pace is the one 12.211 argued for,
    with nothing to revert and nothing to remember.

    Floored at 0.25s. Not because 0.25 is safe — nothing under 2.0 has ever
    been observed — but because a zero or a negative here would remove the
    pacing altogether by typo, and the one failure this whole module is built
    to avoid is the one nobody meant to cause.
    """
    raw = os.getenv("FARES_REQUEST_GAP_SECONDS", "").strip()
    if not raw:
        return DEFAULT_REQUEST_GAP_SECONDS
    try:
        return max(0.25, float(raw))
    except ValueError:
        return DEFAULT_REQUEST_GAP_SECONDS


REQUEST_GAP_SECONDS = _request_gap_seconds()

# What a pass reports for everything it did not do because another pass was
# already doing it. A word in `skipped`, beside `over-budget` and `not-due`,
# because that is what it is: an ordinary reason for a departure not to have
# been polled, arrived at before the first request and reported the same way.
# A cron firing while somebody presses Collect is not a fault and must not read
# like one — see `PassLock`.
ANOTHER_PASS = "another-pass-is-running"

# What a *scheduled* pass reports for the departures it ran out of **window**
# for, as distinct from budget.
#
# A word in `skipped` beside `over-budget` and `not-due`, and for the same
# reason those are words: a pass that quietly stopped half way through is
# indistinguishable from one that found nothing to do (8.8, 8.41).
#
# The window is the scheduler's own interval, and the hazard is specific. The
# task is `MultipleInstances = IgnoreNew`, so an invocation that runs past
# `SCHEDULER_INTERVAL_MINUTES` makes the next firing disappear — no error, no
# log, and no missing data that looks unlike a quiet market. Truncating is how
# a pass declines to cost the following one, and it keeps the near departures
# because `collect_due` hands its queries over nearest-first: 12.111 arriving
# by a third route, exactly as the budget truncation above already argues.
#
# **Only a scheduled pass carries a deadline**, and the asymmetry is the
# decision. A browser press is not on a scheduler; its overrun costs a lock the
# reader chose to hold, and truncating it would be answering "I do not believe
# the last look" with "I looked at some of it".
WINDOW_FULL = "pass-window-full"


class PassObserver(Protocol):
    """
    Somewhere for a pass to say what it is doing while it is still doing it.

    A collection pass is minutes long and the report only exists at the end of
    it, which was fine while a browser sat blocked on the answer and is not
    fine now that one does not — 12.210. Progress is a separate concern from
    the report, so it arrives by a separate route rather than by making
    `CollectionReport` mutable half-way through and hoping every reader knows
    which half they have.

    Both methods are called from the collector's own task and must not block:
    they are for recording what happened, not for reacting to it.
    """

    def planned(self, *, polling: int, skipped: list[tuple[str, str]]) -> None:
        """How many departures this pass means to poll, before the first one."""

    def collected(self, result: "RouteResult", snapshot: "FareSnapshot | None" = None) -> None:
        """
        One departure has come back, whatever it came back with.

        `snapshot` is the board that was **written**, and is `None` whenever
        nothing was: a look that the provider refused, a look the archive could
        not store, and — much the commonest — a look that found the board
        exactly as it was left, which on a half-hourly cadence is most looks.
        That distinction is the whole value of the argument. An observer that
        pushed the board on every look would put a point in front of a reader
        that a page reload would then take away again, because `append_if_changed`
        had decided there was nothing new to record.

        It is a second argument rather than a field on `RouteResult` because the
        two have different jobs and different weights: a result is a summary of
        what happened and is kept for the whole pass, a snapshot is roughly
        3.6 kB of offers that only the observer wants. Thirty-one of them held
        on a report that already says everything the report is read for would be
        a payload riding on a summary.
        """


@dataclass(frozen=True, slots=True)
class FareWatch:
    """
    One watched route: a city pair and a departure **month** — 12.110.

    Deliberately not a `FareQuery`. A query is one request to a provider and
    has to name a day; a watch is what the reader asked for, and since 12.110
    that is a month. Keeping them as two types is what stops the expansion from
    happening twice, or from happening in a place that cannot report the days
    it decided to leave alone.
    """

    origin: str
    destination: str
    #: `YYYY-MM`.
    month: str
    currency: str = "USD"
    # `focus` was here — the one departure the reader meant to take, which
    # changed nothing about what was expanded or how often each day was polled
    # and only decided which day survived a truncated pass (12.130, 12.134).
    # Nothing can set it any more, so it is gone rather than left as a field
    # that is always None in front of an ordering that never fires — 12.266.

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"


@dataclass(frozen=True, slots=True)
class RouteResult:
    origin: str
    destination: str
    flight_date: str
    return_date: str | None
    ok: bool
    #: Whether this look actually wrote a snapshot. False on a poll that found
    #: the board unchanged, which at a half-hourly cadence is most of them.
    changed: bool = False
    #: How many days of the provider's own history were folded in. Non-zero
    #: essentially only on the first look at a departure.
    seeded: int = 0
    offers: int = 0
    cheapest: float | None = None
    currency: str | None = None
    #: Set only when `ok` is false. The machine-readable half of `FareError`.
    error_code: str | None = None
    error_message: str | None = None

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"


@dataclass(frozen=True, slots=True)
class CollectionReport:
    started_at: str
    finished_at: str
    source: str
    results: list[RouteResult]
    #: Departures that were looked at but not polled, with the reason — not
    #: due yet, departed, past the horizon, over the pass's budget, or in a
    #: month nobody could read. Reported rather than dropped, for the same
    #: reason a refusal is (8.8, 8.41): a pass that silently skips half a
    #: watchlist looks like a healthy one.
    #:
    #: Since a watched month expands into thirty-one departures, this is
    #: routinely the longer of the two lists — on a daily cadence a month costs
    #: one poll per day and thirty skips, and that is the design working rather
    #: than failing.
    skipped: list[tuple[str, str]] = field(default_factory=list)

    @property
    def collected(self) -> int:
        return sum(1 for result in self.results if result.ok)

    @property
    def failed(self) -> int:
        return sum(1 for result in self.results if not result.ok)

    @property
    def changed(self) -> int:
        return sum(1 for result in self.results if result.changed)


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


def _declined(
    started_at: str,
    provider: str,
    skipped: list[tuple[str, str]],
    *,
    observer: PassObserver | None = None,
) -> CollectionReport:
    """
    What a pass that never started looks like: a report, not an exception.

    Everything it would have looked at is named, with the reason, which is the
    shape `over-budget` already produces and is there for the same argument
    (8.8, 8.41) — a pass that quietly did nothing is indistinguishable from one
    that found nothing to do, and under a scheduler nobody is watching to tell
    them apart. An observer hears it too, with a denominator of zero, so a
    progress bar reads "nothing to wait for" rather than spinning on a pass that
    is not going to move.
    """
    logger.info("a collection pass is already running; %d departure(s) left to it", len(skipped))
    if observer is not None:
        observer.planned(polling=0, skipped=list(skipped))
    return CollectionReport(
        started_at=started_at,
        finished_at=_now(),
        source=provider,
        results=[],
        skipped=skipped,
    )


async def collect(
    queries: list[FareQuery],
    *,
    provider: str = DEFAULT_PROVIDER,
    history: FareHistory | None = None,
    client: httpx.AsyncClient | None = None,
    gap_seconds: float = REQUEST_GAP_SECONDS,
    observer: PassObserver | None = None,
    budget: DailyBudget | None = None,
    lock: PassLock | None = None,
    pass_id: str | None = None,
    deadline_seconds: float | None = None,
) -> CollectionReport:
    """
    Fetch every query once and append what came back.

    `gap_seconds` is injectable so tests do not sleep; nothing else about the
    pacing is configurable, because the point of a floor is that callers cannot
    lower it by accident.

    **This is the one place a board request is sent, so it is the one place a
    board request is counted.** Every query is written to the day's ledger
    immediately before it goes out, whoever assembled the list — `collect_due`,
    a manual press, or `--all` from the command line — so no path exists that
    spends without saying so.

    It also stops. `collect_due` has already sized its list against what is left
    of the day, so under a scheduler this ceiling is never the thing that bites;
    what it catches is a day exhausted **while this pass is running**, by
    another pass or by the calendar, and a list that was never sized at all.
    The rest come back as `over-budget` in `skipped`, which is the same word and
    the same shape `due_now` uses — and because the caller hands queries over in
    the order they should be spent, stopping part way keeps the near departures
    and drops the far ones, which is 12.111 arriving by a second route.

    **A handed-in `budget` says somebody above already holds the pass lock.**
    That is what `collect_due` does, and it is why this does not take a second
    one and deadlock against itself. Called with no budget — `--all` from the
    command line, a list somebody assembled — this *is* the top of a pass, so it
    takes the lock itself and declines to a report if another pass has it.

    **`pass_id` is carried, never minted.** It names the pass in `fares/passes/`
    and goes onto every spend line this loop writes, and the thing that knows
    where a pass begins and ends is whatever started it — the command line, or a
    runner behind the page. A loop that invented one would be claiming a pass
    boundary it cannot see: a scheduled invocation runs this *and* the horizon,
    and those are one pass. It is also why nothing in this module imports the
    pass ledger. When a budget arrives from above it already carries the id and
    the pace, and this parameter is for the caller that hands over queries
    without one.
    """
    store = history if history is not None else HISTORY
    started_at = _now()
    results: list[RouteResult] = []
    # What this pass wanted and did not send, with the reason. One list for both
    # ways a loop can stop early — a spent day and a full window — because only
    # one of them can happen and they are reported identically.
    declined: list[tuple[str, str]] = []

    # See the docstring: a budget arriving from above brings the lock with it.
    holds_the_pass = budget is None
    pass_lock = lock if lock is not None else PassLock()
    if holds_the_pass and not pass_lock.acquire():
        return _declined(
            started_at,
            provider,
            [(f"{query.route} {query.flight_date}", ANOTHER_PASS) for query in queries],
            observer=observer,
        )
    allowance = (
        budget
        if budget is not None
        else daily_budget(lock=pass_lock, gap=gap_seconds, pass_id=pass_id)
    )

    owned = client is None
    session = client or httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS)
    began = perf_counter()
    try:
        for index, query in enumerate(queries):
            # Beside the budget check and shaped like it, because they are the
            # same kind of stop: wanted, and refused before it was sent.
            if deadline_seconds is not None and perf_counter() - began >= deadline_seconds:
                declined = [
                    (f"{later.route} {later.flight_date}", WINDOW_FULL) for later in queries[index:]
                ]
                logger.warning(
                    "fare collection stopped on the scheduler's window: %d of %d departure(s) left",
                    len(declined),
                    len(queries),
                )
                break
            if not allowance.affords():
                declined = [
                    (f"{later.route} {later.flight_date}", "over-budget")
                    for later in queries[index:]
                ]
                logger.warning(
                    "fare collection stopped on the day's budget: %d of %d departure(s) left",
                    len(declined),
                    len(queries),
                )
                break
            if index:
                await asyncio.sleep(gap_seconds)
            # Before the request rather than after it. The budget protects how
            # much this address has been seen to send, so a request recorded and
            # then failing to leave is the error to make, not the reverse.
            allowance.take(kind="board", what=f"{query.route} {query.flight_date}")
            result, written = await _collect_one(session, query, provider, store)
            results.append(result)
            if observer is not None:
                observer.collected(result, written)
    finally:
        if owned:
            await session.aclose()
        if holds_the_pass:
            pass_lock.release()

    report = CollectionReport(
        started_at=started_at,
        finished_at=_now(),
        source=provider,
        results=results,
        skipped=declined,
    )
    logger.info(
        "fare collection finished: %d looked at, %d changed, %d failed",
        report.collected,
        report.changed,
        report.failed,
    )
    return report


def expand(watched: list[FareWatch]) -> tuple[dict[tuple[str, str, str], FareQuery], list[str]]:
    """
    Every watched month turned into the departures inside it.

    Returned keyed by `(origin, destination, flight_date)` because that is what
    the scheduler and the archive's heartbeats are both keyed by, so the plan
    that comes back can be matched to a query without a second pass.

    A month nobody can read is returned separately rather than dropped. It
    would otherwise vanish between a watchlist of three routes and a report
    about two, which is precisely the silence 8.8 and 8.41 exist to stop.
    """
    queries: dict[tuple[str, str, str], FareQuery] = {}
    unreadable: list[str] = []
    for watch in watched:
        dates = month_dates(watch.month)
        if not dates:
            unreadable.append(f"{watch.route} {watch.month}")
            continue
        for flight_date in dates:
            queries[(watch.origin, watch.destination, flight_date)] = FareQuery(
                origin=watch.origin,
                destination=watch.destination,
                flight_date=flight_date,
                # One way. A month of departures has no single return date to
                # share — see `FareRoute.month` on the web side, 12.113.
                return_date=None,
                currency=watch.currency,
            )
    return queries, unreadable


async def collect_due(
    watched: list[FareWatch],
    *,
    now: datetime | None = None,
    budget: int | None = None,
    cadence: tuple[tuple[int, int], ...] = DEFAULT_CADENCE_MINUTES,
    provider: str = DEFAULT_PROVIDER,
    history: FareHistory | None = None,
    client: httpx.AsyncClient | None = None,
    gap_seconds: float = REQUEST_GAP_SECONDS,
    observer: PassObserver | None = None,
    ledger: RequestLedger | None = None,
    lock: PassLock | None = None,
    force: bool = False,
    pass_id: str | None = None,
    deadline_seconds: float | None = None,
) -> CollectionReport:
    """
    One pass over only the departures that are actually due.

    This is what a scheduler runs every few minutes: it expands each watched
    month into its departures (12.110), asks the archive when each of them was
    last looked at, applies the cadence for how far away it is, and polls the
    ones whose turn has come. Everything it decides not to poll comes back in
    `skipped` with the reason, so a pass that does nothing can still say why it
    did nothing.

    The cadence is applied per departure and not per month — 12.111. A month is
    thirty-one days spread over thirty-one different distances, and giving it
    one rate would mean either polling its far end as often as its near end, or
    the reverse. The arithmetic settles it: a month whose first day is a week
    away costs 936 requests a day at the near rate applied throughout, against
    a 300 budget, while the same month at 200 days out costs 31.

    A watch used to be able to name one of its own departures as the focus, and
    the only thing that did here was put it at the front of the queue for the
    truncation — 12.134. Nothing names one now (12.260), so the queue is
    ordered by readiness and then by distance, which is 12.111 and is what the
    focus was jumping ahead of.

    **`budget` is a day's ceiling, and by default there is not one.**
    `daily_request_budget()` answers `None` unless an environment sets a number,
    `DailyBudget.remaining` passes that `None` through, and `due_now` has always
    read `budget=None` as "do not truncate" — so on an ordinary install every
    due departure is polled and nothing here comes back `over-budget` at all.
    `config.py` records why: the ceiling bounded a count nobody had measured,
    while what protects this address is the pace, which is untouched.

    Everything below still works the moment a number is configured, and this
    parameter is how a caller supplies one directly. It is the *day's* ceiling
    and not the pass's — it used to be both, handed straight to `due_now` as a
    per-pass cap with nothing carrying spend from one pass to the next, so a
    scheduler running this every fifteen minutes gave ninety-six passes the
    whole budget each and the day's total was bounded by nothing. What a pass
    may spend is the ceiling **less what the day has already spent**, read off
    the ledger in `fare_budget`, with the same `over-budget` reason, the same
    nearest-first ordering (12.111) and the same everything-is-reported contract
    (8.8, 8.41).

    Under a configured ceiling the truncation is then reached two ways. By
    **watching more routes**: a pass has as many candidates as there are watched
    departures, thirty-one per month, so against a fresh 600 that is nineteen
    routes before a single day is dropped. And by **the day filling up** — the
    fifteenth pass of a day that has spent its 600 polls nothing at all and says
    so, thirty-one times, by name, which is the behaviour that stopped being the
    default.

    **And it is the one pass on this address, which the ledger alone cannot make
    true.** The lock is taken *before* the plan below rather than around the
    ledger's append, because the append was never the dangerous part: two passes
    starting together would each read a day with room in it, each size a whole
    day's work against that, and each begin spending before either could see the
    other. Taken here, the second finds it held and declines with every departure
    named — a report, not an exception, because a cron firing while the owner
    presses Collect is the ordinary case and not a fault.

    **`force` is the reader saying they do not believe the last look** —
    `a-press-collects-the-month-it-is-on`, which settles 12.212. It reaches
    `due_now` and turns `not-due` into `forced` there; it reaches nothing else
    in this function, and deliberately.

    Three things it does **not** touch, each for its own reason. The lock is
    taken first exactly as before, so a forced press that arrives while the
    scheduled pass is running sends nothing and reports every departure as
    `another-pass-is-running` — being second is not an error and a press cannot
    make it one. The allowance is read off the same day's ledger and handed to
    the same truncation, so a forced press on a spent day polls nothing and says
    `over-budget` thirty-one times; the cadence is a judgement about pace that a
    reader may overrule, and the budget is a bound on what this address sends
    that nobody may. And the pacing is untouched, so a forced month is still
    thirty-one requests three seconds apart rather than a burst.

    What it costs is bounded by its caller rather than by anything here: the one
    thing that sets it is a press on a single route's row, which is one watch,
    which is at most thirty-one departures.
    """
    store = history if history is not None else HISTORY
    moment = now if now is not None else datetime.now(UTC)
    started_at = _now()

    by_key, unreadable = expand(watched)
    skipped = [(what, "unreadable-month") for what in unreadable]

    pass_lock = lock if lock is not None else PassLock()
    if not pass_lock.acquire():
        return _declined(
            started_at,
            provider,
            skipped
            + [
                (f"{origin}-{destination} {day}", ANOTHER_PASS)
                for origin, destination, day in by_key
            ],
            observer=observer,
        )

    try:
        allowance = daily_budget(
            ceiling=budget if budget is not None else daily_request_budget(),
            ledger=ledger,
            now=moment,
            lock=pass_lock,
            # What the pass is about to spend at, and which pass is spending —
            # both onto every line the day's ledger records below, so the pace
            # of a request stops being something reconstructed from the gaps
            # between timestamps.
            gap=gap_seconds,
            pass_id=pass_id,
        )

        plan = due_now(
            list(by_key),
            store.last_checked(),
            moment,
            cadence=cadence,
            budget=allowance.remaining(),
            force=force,
        )

        queries = [by_key[(d.origin, d.destination, d.flight_date)] for d in plan if d.ready]
        # Settled before the first request rather than after the last, because a
        # pass that now runs unattended has to be able to say what it is not going
        # to do at the moment it starts — otherwise the only honest progress figure
        # for the first four minutes is "unknown".
        skipped += [(f"{d.route} {d.flight_date}", d.reason) for d in plan if not d.ready]
        if observer is not None:
            observer.planned(polling=len(queries), skipped=skipped)

        report = await collect(
            queries,
            provider=provider,
            history=store,
            client=client,
            gap_seconds=gap_seconds,
            observer=observer,
            # Handing the allowance over is also what tells `collect` the lock is
            # already held, so it does not take a second one against itself.
            budget=allowance,
            # `None` for everything except the scheduled command — see
            # `WINDOW_FULL`. A press is not on a scheduler and is not truncated.
            deadline_seconds=deadline_seconds,
        )
    finally:
        pass_lock.release()

    return CollectionReport(
        started_at=report.started_at,
        finished_at=report.finished_at,
        source=report.source,
        results=report.results,
        # The plan's skips, then anything the day ran out on while the pass was
        # still running. Two lists because they are settled at two different
        # moments and only the first one can be announced to an observer before
        # the first request; joined here because a reader wants one answer to
        # "what did this pass not do".
        skipped=skipped + report.skipped,
    )


# ------------------------------------------------------------- the calendar --
#
# A watched month is collected board by board above. Every *other* month out to
# the booking horizon is collected here, as one cheapest fare per departure
# date, because Google's price graph answers a whole range in one request.
#
# **Cadence: once a day per route, and no new scheduler for it.** 12.17 says the
# rate follows how far away the departure is, and that rule has nothing to grip
# on here: one curve spans every distance from today to 330 days out at once, so
# there is no single `days_out` to look up. What settles it is the same
# measurement the cadence table came from — a fare 14 days out moved on 27% of
# days by a median 14%, one 150 days out on 22% by 1.7%. The near end is where
# the news is, and the near end is already on the half-hourly board cadence for
# the month the reader is actually watching; what this adds is the far months,
# which move by under 2% a day. Daily is also the resolution of the free history
# in `MAX_POLL_MINUTES`, so anything slower would be below it. 12.10's pacing
# still governs: sequential, `REQUEST_GAP_SECONDS` apart, in the same pass — the
# gap itself is three since 12.211 and the shape of it has not moved.


class CalendarObserver(Protocol):
    """
    Somewhere for a horizon pass to say what it is doing while it is doing it.

    `PassObserver`'s twin and deliberately not `PassObserver` itself, because
    the two passes count different things and a shared protocol would have to
    be about neither. A board pass counts **departures**: it settles a list of
    up to thirty-one of them, polls each one once, and `completed / polling` is
    the whole story. A horizon pass has one city pair and no departures to
    count — what moves is **windows priced and requests spent**, and those are
    not the same number since 12.245, because a refused far end is walked back
    and asked for again.

    Reusing the departure vocabulary would have meant reporting "1 of 2
    departures" for a pass that polls none, which is the class of borrowed unit
    that makes a progress bar mean nothing.

    Every method is called from the collector's own task and must not block.
    """

    def planned(self, *, windows: int, skipped: list[tuple[str, str]]) -> None:
        """
        How many windows this pass means to price, before the first request.

        A real denominator and settled early, which is what lets the row draw a
        bar rather than a spinner: `calendar_windows` cuts the horizon into a
        fixed list before anything is asked for, and which pairs are due is a
        read off the archive. Zero is a genuine answer — every pair collected
        inside its cadence — and is a different fact from "not settled yet".
        """

    def requested(self) -> None:
        """
        One upstream request has just been sent.

        Separate from `priced` below because of what 12.245 does to the
        relationship: a refused window is asked for again with a nearer end, so
        one window can cost up to six requests. A reader watching a pass that
        has sent three requests and priced one window is watching the retry
        work, and collapsing the two counts would hide it.
        """

    def priced(self, *, dates: int) -> None:
        """One window has come back, with however many departure dates in it."""


@dataclass(frozen=True, slots=True)
class CalendarResult:
    origin: str
    destination: str
    ok: bool
    #: Whether this look wrote a curve. False when nothing in the year moved.
    changed: bool = False
    #: How many departure dates came back, priced or not.
    dates: int = 0
    #: How many of them had a fare. A day with no flights is an answer.
    priced: int = 0
    cheapest: float | None = None
    cheapest_on: str | None = None
    currency: str | None = None
    requests: int = 0
    error_code: str | None = None
    error_message: str | None = None

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"


@dataclass(frozen=True, slots=True)
class CalendarReport:
    started_at: str
    finished_at: str
    source: str
    results: list[CalendarResult]
    #: Routes looked at and not polled, with the reason. Same contract as
    #: `CollectionReport.skipped` — 8.8 and 8.41.
    skipped: list[tuple[str, str]] = field(default_factory=list)

    @property
    def collected(self) -> int:
        return sum(1 for result in self.results if result.ok)

    @property
    def failed(self) -> int:
        return sum(1 for result in self.results if not result.ok)

    # How many curves this pass actually wrote. Spelled out here rather than
    # summed at each reader, the same as `CollectionReport.changed`, because
    # there are now two readers — the log line below and the endpoint — and a
    # figure counted twice is a figure that can disagree with itself.
    @property
    def changed(self) -> int:
        return sum(1 for result in self.results if result.changed)

    @property
    def requests(self) -> int:
        return sum(result.requests for result in self.results)


def calendar_windows(
    today: datetime,
    *,
    horizon_days: int = MAX_DEPARTURE_HORIZON_DAYS,
    width_days: int = CALENDAR_RANGE_DAYS,
) -> list[tuple[str, str]]:
    """
    The whole booking horizon, cut into windows one request can carry.

    Measured 2026-08-19: a 181-date window answered in full and the whole
    331-date horizon was refused outright, so this is two requests per route and
    cannot be one. The windows are contiguous and inclusive at both ends, which
    is why the second starts the day after the first ends rather than repeating
    a date — a repeated departure would be stored twice under one key and the
    later answer would silently win.
    """
    start = today.date()
    windows: list[tuple[str, str]] = []
    offset = 0
    while offset <= horizon_days:
        last = min(offset + width_days - 1, horizon_days)
        windows.append(
            (
                (start + timedelta(days=offset)).isoformat(),
                (start + timedelta(days=last)).isoformat(),
            )
        )
        offset = last + 1
    return windows


async def collect_calendars(
    watched: list[FareWatch],
    *,
    now: datetime | None = None,
    every_minutes: int = CALENDAR_POLL_MINUTES,
    provider: str = DEFAULT_PROVIDER,
    calendar: FareCalendar | None = None,
    client: httpx.AsyncClient | None = None,
    gap_seconds: float = REQUEST_GAP_SECONDS,
    observer: CalendarObserver | None = None,
    budget: int | None = None,
    ledger: RequestLedger | None = None,
    lock: PassLock | None = None,
    force: bool = False,
    pass_id: str | None = None,
) -> CalendarReport:
    """
    One cheapest fare per departure date, out to the horizon, per city pair.

    Keyed by city pair and not by watch: a calendar covers every month at once,
    so two watches on one pair are one collection. The months the reader
    actually watches are collected board by board elsewhere and are not skipped
    here — the curve is what makes the *other* eleven months visible, and having
    both is what lets a reader see that the month they picked is the dear one.

    **These requests are counted, and until now they were not.** This function
    took no budget at all. At today's daily cadence that is about 12 requests a
    day and invisible; at an hourly refresh it would be ~350, more than the
    whole ceiling, spent by the cheap pass on the far months while the boards
    the reader is actually watching went unpolled. It shares the day's ledger
    with the boards rather than getting an allowance of its own, because what
    the budget bounds is one address and the upstream cannot tell the two passes
    apart.

    **What is counted is what was sent.** A pair costs two windows in the
    ordinary case and up to twelve requests in the worst, because a refused far
    end is walked back and asked for again (12.245) — measured, the real rate is
    **2.43 requests per pair per day and not 2**. So the count is taken in
    `_price_window`, one per attempt including every retry, rather than derived
    from the window list, which is what a pass planned rather than what it did.

    **A pair is begun only if the whole of it fits.** Two windows are one
    observation of one year and half a curve is never stored (12.4), so a pair
    that cannot afford its own window count is skipped whole, as `over-budget`,
    before the first request. Watchlist order decides who goes short, which is
    the order this pass already polls in — a curve spans every distance at once
    and so has no nearest-first to sort by, unlike the boards.

    **It takes a lock of its own and deliberately not the boards'.** The two
    slots are a decision `calendar_job` already records and argues: a board pass
    is minutes long over dozens of departures and a calendar pass is two
    requests, so sharing one would make a route added mid-board-pass go without
    the curve this exists to fetch immediately — and it would not queue for it,
    it would decline. So what this closes is the calendar slot across processes,
    which is a second calendar pass. Nothing about the boards changes and the
    open question about a shared *queue* is left exactly where that module left
    it. The day is still safe either way: only a board pass ever plans a whole
    day, while this allots one request per window per pair, checks what is left
    before each pair, and re-checks before every walk-back attempt.

    A pass declined here reports every pair as `another-pass-is-running`, the
    same word the boards use for every departure.

    **`force` is the reader saying they do not believe the curve on disk**, and
    it is the calendar's half of `a-press-collects-the-month-it-is-on` (12.212).
    It moves exactly one branch below: the pair that would have been `not-due`
    is collected instead. It moves nothing else, and the two things it
    deliberately does not touch are the same two the boards' `force` leaves
    alone. The lock is still taken first, so a forced press that meets a
    scheduled pass reports `another-pass-is-running` — being second is not an
    error and a press cannot make it one. And the day's allowance is still
    allotted after this, so a forced pair that cannot afford its own windows
    still comes back `over-budget` by name: the cadence is a judgement about
    pace that a reader may overrule, while the ledger is a bound on what this
    address sends that nobody may.

    **It is refused for more than one city pair, and that is the bound the whole
    decision turns on.** 12.212 costed a press generously because it assumed a
    pass over the whole watchlist; what made forcing acceptable was that a press
    can only ever name one row. The boards enforce that in the router because
    their body carries a list; this endpoint's body carries one origin and one
    destination, so a press is one pair by the shape of the request and there is
    nothing there to check. The place the bound can actually be crossed is
    *here* — the scheduled pass hands this function the whole watchlist, and a
    `force` riding along with it would poll every pair the cadence had declined
    at a measured 2.43 requests each. So the refusal lives where the crossing
    would happen, which makes the bound the collector's rather than a habit of
    whoever calls it.
    """
    store = calendar if calendar is not None else CALENDAR
    moment = now if now is not None else datetime.now(UTC)
    started_at = _now()

    # `dict` rather than `set`, so the order a watchlist was written in is the
    # order it is polled in. A set would reorder the pass every run and make two
    # passes impossible to compare by eye.
    pairs: dict[tuple[str, str], str] = {}
    for watch in watched:
        pairs.setdefault((watch.origin, watch.destination), watch.currency)

    # Before the lock rather than after it, so a call that was never allowed is
    # refused without first closing the slot against a pass that is entitled to
    # it. This is a programming error and not a caller's mistake — no HTTP body
    # can reach it with more than one pair — so it raises rather than travelling
    # back as a skipped reason: a `ValueError` names the line that did it, while
    # a report of twelve `forced` pairs would look exactly like a pass working.
    if force and len(pairs) > 1:
        raise ValueError(f"A forced collection covers one city pair; {len(pairs)} were handed over")

    pass_lock = lock if lock is not None else PassLock(name=CALENDAR_LOCK_NAME)
    if not pass_lock.acquire():
        declined = [(f"{origin}-{destination}", ANOTHER_PASS) for origin, destination in pairs]
        logger.info(
            "a collection pass is already running; %d calendar(s) left to it", len(declined)
        )
        if observer is not None:
            observer.planned(windows=0, skipped=list(declined))
        return CalendarReport(
            started_at=started_at,
            finished_at=_now(),
            source=provider,
            results=[],
            skipped=declined,
        )

    allowance = daily_budget(
        ceiling=budget if budget is not None else daily_request_budget(),
        ledger=ledger,
        now=moment,
        lock=pass_lock,
        # A scheduled invocation runs the boards and then this, and hands both
        # the same `pass_id` — because what has to fit inside the scheduler's
        # fifteen-minute interval is the invocation rather than either loop, so
        # the two are one pass and the day's ledger has to say so.
        gap=gap_seconds,
        pass_id=pass_id,
    )

    windows = calendar_windows(moment)
    results: list[CalendarResult] = []
    skipped: list[tuple[str, str]] = []

    try:
        # Which pairs are due, decided for all of them before any of them is
        # collected. It used to be decided inside the loop, one pair at a time,
        # and the move is what lets the pass state its own size before it spends
        # a request — `CalendarObserver.planned` needs a denominator, and a plan
        # that settles pair by pair is a denominator that grows while a bar is
        # drawing against it. Nothing about the outcome changes: `due` reads the
        # last check for one pair, and collecting a different pair cannot alter
        # it.
        #
        # The day's allowance is allotted here too, for the same reason: a pair
        # that cannot afford its own windows is a pair this pass is not going to
        # poll, and a denominator that says otherwise is a bar drawing against
        # work that will never happen. Allotted at the ordinary cost of a pair —
        # one request per window — because that is the only figure knowable
        # before the first answer; the walk-back can push a pair past its
        # allotment and the guard in `_price_window` is what catches that.
        due: list[tuple[tuple[str, str], str]] = []
        allotted = 0
        for pair, currency in pairs.items():
            # `force` short-circuits the store's answer and nothing else. Read
            # here rather than by handing `every_minutes=0` down to `due`, which
            # would reach the same collection by a different claim: zero is a
            # cadence, and a pass that says its cadence is zero minutes is
            # saying something about policy where the truth is that one reader
            # overruled it once. The endpoint's other exception genuinely *is* a
            # cadence — a pair with no curve has nothing to protect — and the
            # two stay apart so a log can tell them apart.
            if not force and not store.due(pair[0], pair[1], moment, every_minutes=every_minutes):
                skipped.append((f"{pair[0]}-{pair[1]}", "not-due"))
            elif not allowance.affords(allotted + len(windows)):
                skipped.append((f"{pair[0]}-{pair[1]}", "over-budget"))
            else:
                allotted += len(windows)
                due.append((pair, currency))
        if observer is not None:
            observer.planned(windows=len(due) * len(windows), skipped=list(skipped))

        owned = client is None
        session = client or httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS)
        spent = 0
        try:
            for (origin, destination), currency in due:
                if spent:
                    await asyncio.sleep(gap_seconds)
                result = await _collect_calendar(
                    session,
                    origin,
                    destination,
                    currency,
                    windows,
                    provider,
                    store,
                    gap_seconds,
                    observer,
                    allowance,
                )
                spent += result.requests
                results.append(result)
        finally:
            if owned:
                await session.aclose()
    finally:
        # Outside the session's own `finally`, so a pass that fell over while
        # reading its own store — before a client existed — still lets the next
        # one start rather than leaving it to time out as stale.
        pass_lock.release()

    report = CalendarReport(
        started_at=started_at,
        finished_at=_now(),
        source=provider,
        results=results,
        skipped=skipped,
    )
    logger.info(
        "fare calendar pass finished: %d route(s) in %d request(s), %d changed, %d failed",
        report.collected,
        report.requests,
        report.changed,
        report.failed,
    )
    return report


#: How far back a refused window's far end may be walked, and in what steps.
#:
#: Measured 2026-08-20: the same window answers ending +329 days out and is
#: refused ending +330, and the day before *that* +330 answered — so the edge
#: is a calendar date the provider will price up to, not a distance from today,
#: and it therefore moves one day closer every day until the provider extends
#: its schedule. A single fixed step would work for exactly one day. Doubling
#: finds an edge a month adrift in five extra requests and costs one in the
#: ordinary case, and the total is bounded so a provider that stops answering
#: entirely is reported rather than probed at forever.
_NARROW_STEPS = (1, 2, 4, 8, 16)


async def _price_window(
    client: httpx.AsyncClient,
    origin: str,
    destination: str,
    currency: str,
    start: str,
    end: str,
    provider: str,
    gap_seconds: float,
    observer: CalendarObserver | None = None,
    budget: DailyBudget | None = None,
) -> tuple[list[CalendarPrice], int, FareError | None]:
    """
    One window's prices, narrowing the far end if the provider will not reach it.

    Only `range-refused` is retried, and only by asking for *less*. Every other
    refusal is the caller's to report unchanged — a parse failure or a consent
    page does not become an answer by being asked again, and 12.4 wants those
    loud rather than smoothed over by a retry loop.

    The window that comes back is the window that was answered, and the curve
    records its own `from`/`to`, so a horizon that fell short says so on disk
    instead of looking like a year nobody priced the end of.

    **This is where a calendar request is counted, because this is where one is
    sent.** The caller allotted a pair one request per window; the walk-back can
    ask for up to five more, so the ceiling is checked again here, immediately
    before each attempt. Running out mid-curve is reported as `budget-exhausted`
    and the whole curve fails — the same treatment a refusal gets, and for the
    same reason: half a year in the archive is a curve that stops in February
    for a reason the file does not record.
    """
    requests = 0
    attempt_end = end
    for step in (0, *_NARROW_STEPS):
        if step:
            attempt_end = _days_before(end, sum(_NARROW_STEPS[: _NARROW_STEPS.index(step) + 1]))
            if attempt_end <= start:
                break
            await asyncio.sleep(gap_seconds)
        if budget is not None and not budget.affords():
            return (
                [],
                requests,
                FareError(
                    "budget-exhausted",
                    "The day's request budget ran out part way through this curve",
                    route=f"{origin}-{destination}",
                ),
            )
        requests += 1
        # Announced before the wait for the answer rather than after it, which
        # is the only placement that helps: a request takes seconds and it is
        # exactly those seconds a reader is sitting through. Saying so
        # afterwards would move the count at the moment the wait ended.
        if observer is not None:
            observer.requested()
        if budget is not None:
            budget.take(kind="calendar", what=f"{origin}-{destination} {start}..{attempt_end}")
        try:
            points = await fetch_calendar(
                client,
                CalendarQuery(
                    origin=origin,
                    destination=destination,
                    start=start,
                    end=attempt_end,
                    currency=currency,
                ),
                provider=provider,
            )
        except FareError as error:
            if error.code != "range-refused":
                return [], requests, error
            refusal = error
            continue
        if step:
            logger.info(
                "fare calendar narrowed %s-%s to %s..%s after %d refusal(s)",
                origin,
                destination,
                start,
                attempt_end,
                requests - 1,
            )
        return points, requests, None
    return [], requests, refusal


def _days_before(day: str, days: int) -> str:
    """`YYYY-MM-DD` moved back, through the calendar rather than through a clock."""
    return (date.fromisoformat(day) - timedelta(days=days)).isoformat()


async def _collect_calendar(
    client: httpx.AsyncClient,
    origin: str,
    destination: str,
    currency: str,
    windows: list[tuple[str, str]],
    provider: str,
    store: FareCalendar,
    gap_seconds: float,
    observer: CalendarObserver | None = None,
    budget: DailyBudget | None = None,
) -> CalendarResult:
    looked_at = _now()
    points = []
    requests = 0

    for index, (start, end) in enumerate(windows):
        if index:
            await asyncio.sleep(gap_seconds)
        window_points, spent, error = await _price_window(
            client,
            origin,
            destination,
            currency,
            start,
            end,
            provider,
            gap_seconds,
            observer,
            budget,
        )
        requests += spent
        if error is None:
            points.extend(window_points)
            # Counted as it comes back rather than at the end of the pair. The
            # second window is a request and a paced wait behind the first, and
            # a reader who is told nothing until both have landed is watching
            # the same sentence for the whole of it — which is the fault this
            # is here to remove.
            if observer is not None:
                observer.priced(dates=len(window_points))
        else:
            # The whole curve fails, not the window. Two windows are one
            # observation of one year, and storing half of it would put a curve
            # in the archive that stops in February for a reason the file does
            # not record — exactly the quiet partial answer 12.4 forbids.
            logger.warning(
                "fare calendar refused %s-%s %s..%s: %s",
                origin,
                destination,
                start,
                end,
                error.message,
            )
            store.record_check(
                origin,
                destination,
                at=looked_at,
                outcome="error",
                error_code=error.code,
            )
            return CalendarResult(
                origin=origin,
                destination=destination,
                ok=False,
                requests=requests,
                error_code=error.code,
                error_message=error.message,
            )

    # One entry per departure date, whatever the windows did. They are built
    # contiguous so an overlap should be impossible, but the stored row is a map
    # keyed by date and would collapse a repeat silently — leaving the count in
    # this report saying 42 where the archive holds 21. A number that disagrees
    # with the file it describes is worse than either number alone.
    by_date = {point.departure_date: point for point in points}
    curve = CalendarCurve(
        captured_at=looked_at,
        source=provider,
        origin=origin,
        destination=destination,
        currency=currency.upper(),
        start=windows[0][0],
        end=windows[-1][1],
        prices=sorted(by_date.values(), key=lambda point: point.departure_date),
    )
    try:
        changed = store.append_if_changed(curve)
    except OSError as error:
        store.record_check(
            origin, destination, at=looked_at, outcome="error", error_code="write-failed"
        )
        return CalendarResult(
            origin=origin,
            destination=destination,
            ok=False,
            requests=requests,
            error_code="write-failed",
            error_message=str(error),
        )

    cheapest = curve.cheapest
    priced = sum(1 for point in curve.prices if point.price is not None)
    store.record_check(
        origin,
        destination,
        at=looked_at,
        outcome="changed" if changed else "unchanged",
        dates=len(curve.prices),
        cheapest=cheapest.price if cheapest else None,
    )
    return CalendarResult(
        origin=origin,
        destination=destination,
        ok=True,
        changed=changed,
        dates=len(curve.prices),
        priced=priced,
        cheapest=cheapest.price if cheapest else None,
        cheapest_on=cheapest.departure_date if cheapest else None,
        currency=curve.currency,
        requests=requests,
    )


async def _collect_one(
    client: httpx.AsyncClient,
    query: FareQuery,
    provider: str,
    store: FareHistory,
) -> tuple[RouteResult, FareSnapshot | None]:
    """
    Look at one departure, and say what happened and what was written.

    The second half of the pair is the board **if the archive took it**, and
    `None` on every path where nothing was stored — a refusal, a failed write,
    or a board that had not moved. It exists so a `PassObserver` can push the
    new point at a reader while the pass is still running, and the alternative
    was for that observer to re-read the file it had just been told about.
    Nothing in the returned report carries it; `collect` hands it straight to
    the observer and lets it go.
    """

    def outcome(
        *,
        ok: bool,
        changed: bool = False,
        seeded: int = 0,
        offers: int = 0,
        cheapest: float | None = None,
        currency: str | None = None,
        error_code: str | None = None,
        error_message: str | None = None,
    ) -> RouteResult:
        """
        A result with the route already filled in.

        The signature is spelled out rather than taking `**fields`, which would
        be shorter and would collapse six field types into `object` — buying a
        `type: ignore` to hide the collapse. This repo has been here before.
        """
        return RouteResult(
            origin=query.origin,
            destination=query.destination,
            flight_date=query.flight_date,
            return_date=query.return_date,
            ok=ok,
            changed=changed,
            seeded=seeded,
            offers=offers,
            cheapest=cheapest,
            currency=currency,
            error_code=error_code,
            error_message=error_message,
        )

    looked_at = _now()
    try:
        result = await fetch_search(client, query, provider=provider)
    except FareError as error:
        logger.warning("fare collection refused %s: %s", query.route, error.message)
        store.record_check(
            query.origin,
            query.destination,
            query.flight_date,
            at=looked_at,
            outcome="error",
            error_code=error.code,
        )
        return outcome(ok=False, error_code=error.code, error_message=error.message), None

    snapshot = FareSnapshot(
        captured_at=looked_at,
        source=provider,
        origin=query.origin,
        destination=query.destination,
        flight_date=query.flight_date,
        return_date=query.return_date,
        currency=query.currency.upper(),
        offers=result.offers,
        insights=result.insights,
    )

    # Airports are folded in on every pass. It is a dictionary write of a
    # handful of entries, and it means a route added today has coordinates
    # from its very first collection rather than from whenever someone
    # remembered to backfill them.
    store.merge_airports(result.airports)

    seeded = 0
    if result.history and not store.has_baseline(
        query.origin, query.destination, query.flight_date
    ):
        # Once per departure, on the first look. The window rolls, so a second
        # seeding later would still be a merge rather than a duplicate — but
        # spending the check on every poll would be paying for nothing.
        try:
            seeded = store.merge_baseline(
                query.origin,
                query.destination,
                query.flight_date,
                result.history,
                source=f"{provider}-history",
                currency=snapshot.currency,
            )
        except OSError:
            # The baseline is context, not the observation. Losing it must not
            # cost the snapshot standing right behind it.
            seeded = 0

    # Asked before the write, because writing is what replaces the old
    # fingerprint with the new one and the question is about the old one.
    rebaselined = store.is_rebaseline(snapshot)

    try:
        changed = store.append_if_changed(snapshot)
    except OSError as error:
        # The fetch succeeded and the archive did not. Reported as a failure
        # because from the caller's side nothing was collected.
        store.record_check(
            query.origin,
            query.destination,
            query.flight_date,
            at=looked_at,
            outcome="error",
            error_code="write-failed",
        )
        return outcome(ok=False, error_code="write-failed", error_message=str(error)), None

    cheapest = snapshot.cheapest
    store.record_check(
        query.origin,
        query.destination,
        query.flight_date,
        at=looked_at,
        # `rebaselined` rather than `changed`, so the one snapshot a reader
        # change forces is not counted as a fare moving. `/fares/watch` counts
        # only `changed`, which means the health figure stays honest without
        # the archive hiding that the write happened.
        outcome=("rebaselined" if rebaselined else "changed") if changed else "unchanged",
        offers=len(result.offers),
        cheapest=cheapest.price if cheapest else None,
    )
    return (
        outcome(
            ok=True,
            changed=changed,
            seeded=seeded,
            offers=len(result.offers),
            cheapest=cheapest.price if cheapest else None,
            currency=snapshot.currency,
        ),
        # Only when the archive actually took it. A look that found the board
        # unchanged wrote nothing, so pushing the board would show a reader a
        # point that is not in the file behind it.
        snapshot if changed else None,
    )
