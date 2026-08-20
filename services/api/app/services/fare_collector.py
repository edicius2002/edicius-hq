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
from dataclasses import dataclass, field
from datetime import UTC, date, datetime, timedelta
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
REQUEST_GAP_SECONDS = 3.0


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

    def collected(self, result: "RouteResult") -> None:
        """One departure has come back, whatever it came back with."""


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


async def collect(
    queries: list[FareQuery],
    *,
    provider: str = DEFAULT_PROVIDER,
    history: FareHistory | None = None,
    client: httpx.AsyncClient | None = None,
    gap_seconds: float = REQUEST_GAP_SECONDS,
    observer: PassObserver | None = None,
) -> CollectionReport:
    """
    Fetch every query once and append what came back.

    `gap_seconds` is injectable so tests do not sleep; nothing else about the
    pacing is configurable, because the point of a floor is that callers cannot
    lower it by accident.
    """
    store = history if history is not None else HISTORY
    started_at = _now()
    results: list[RouteResult] = []

    owned = client is None
    session = client or httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS)
    try:
        for index, query in enumerate(queries):
            if index:
                await asyncio.sleep(gap_seconds)
            result = await _collect_one(session, query, provider, store)
            results.append(result)
            if observer is not None:
                observer.collected(result)
    finally:
        if owned:
            await session.aclose()

    report = CollectionReport(
        started_at=started_at,
        finished_at=_now(),
        source=provider,
        results=results,
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

    That truncation is reached by **watching more routes**, not by waiting.
    `spend` below is a per-pass ceiling and one pass has as many candidates as
    there are watched departures, so 300 / 31 is the whole of it: nine routes
    never truncate and ten always can. Measured in `due_now`'s docstring, where
    the ordering it decides lives.

    `spend` also falls back to `daily_request_budget()`, which is a day's
    figure being used as a pass's. Nothing here or anywhere else carries spend
    from one pass to the next, so the daily budget the name promises is not
    actually enforced — a gap from 12.111, named here rather than fixed here.
    """
    store = history if history is not None else HISTORY
    moment = now if now is not None else datetime.now(UTC)
    spend = budget if budget is not None else daily_request_budget()

    by_key, unreadable = expand(watched)
    plan = due_now(
        list(by_key),
        store.last_checked(),
        moment,
        cadence=cadence,
        budget=spend,
    )

    queries = [by_key[(d.origin, d.destination, d.flight_date)] for d in plan if d.ready]
    # Settled before the first request rather than after the last, because a
    # pass that now runs unattended has to be able to say what it is not going
    # to do at the moment it starts — otherwise the only honest progress figure
    # for the first four minutes is "unknown".
    skipped = [(what, "unreadable-month") for what in unreadable]
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
    )
    return CollectionReport(
        started_at=report.started_at,
        finished_at=report.finished_at,
        source=report.source,
        results=report.results,
        skipped=skipped,
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
) -> CalendarReport:
    """
    One cheapest fare per departure date, out to the horizon, per city pair.

    Keyed by city pair and not by watch: a calendar covers every month at once,
    so two watches on one pair are one collection. The months the reader
    actually watches are collected board by board elsewhere and are not skipped
    here — the curve is what makes the *other* eleven months visible, and having
    both is what lets a reader see that the month they picked is the dear one.
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

    windows = calendar_windows(moment)
    results: list[CalendarResult] = []
    skipped: list[tuple[str, str]] = []

    owned = client is None
    session = client or httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS)
    spent = 0
    try:
        for (origin, destination), currency in pairs.items():
            if not store.due(origin, destination, moment, every_minutes=every_minutes):
                skipped.append((f"{origin}-{destination}", "not-due"))
                continue
            if spent:
                await asyncio.sleep(gap_seconds)
            result = await _collect_calendar(
                session, origin, destination, currency, windows, provider, store, gap_seconds
            )
            spent += result.requests
            results.append(result)
    finally:
        if owned:
            await session.aclose()

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
    """
    requests = 0
    attempt_end = end
    for step in (0, *_NARROW_STEPS):
        if step:
            attempt_end = _days_before(end, sum(_NARROW_STEPS[: _NARROW_STEPS.index(step) + 1]))
            if attempt_end <= start:
                break
            await asyncio.sleep(gap_seconds)
        requests += 1
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
) -> CalendarResult:
    looked_at = _now()
    points = []
    requests = 0

    for index, (start, end) in enumerate(windows):
        if index:
            await asyncio.sleep(gap_seconds)
        window_points, spent, error = await _price_window(
            client, origin, destination, currency, start, end, provider, gap_seconds
        )
        requests += spent
        if error is None:
            points.extend(window_points)
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
) -> RouteResult:
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
        return outcome(ok=False, error_code=error.code, error_message=error.message)

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
        return outcome(ok=False, error_code="write-failed", error_message=str(error))

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
    return outcome(
        ok=True,
        changed=changed,
        seeded=seeded,
        offers=len(result.offers),
        cheapest=cheapest.price if cheapest else None,
        currency=snapshot.currency,
    )
