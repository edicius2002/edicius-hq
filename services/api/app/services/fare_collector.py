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
from datetime import UTC, datetime

import httpx

from app.adapters.fares.models import FareError, FareQuery, FareSnapshot
from app.adapters.fares.registry import DEFAULT_PROVIDER, fetch_search
from app.config import (
    DEFAULT_CADENCE_MINUTES,
    UPSTREAM_TIMEOUT_SECONDS,
    daily_request_budget,
)
from app.services.fare_history import HISTORY, FareHistory
from app.services.fare_schedule import due_now, month_dates

logger = logging.getLogger(__name__)

# Seconds between upstream requests. Slow enough to look like a person browsing,
# fast enough that a twenty-route watchlist finishes in a couple of minutes.
REQUEST_GAP_SECONDS = 6.0


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
    #: `YYYY-MM-DD` inside `month`, or None — the one departure the reader
    #: actually means to take (12.130). It changes nothing about what is
    #: expanded or how often each day is polled; it changes which day survives
    #: a truncated pass (12.134).
    focus: str | None = None

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
            results.append(await _collect_one(session, query, provider, store))
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

    A watch may name one of its own departures as the focus, and the only thing
    that does here is put it at the front of the queue for the truncation —
    12.134. It is not polled more often and it is not exempt from the cadence;
    if it is not due it is skipped by name like any other day.

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
    # Membership in `by_key` *is* the "inside its own month" check — it holds
    # exactly the departures the watched month expanded into. Validating the
    # focus separately would be a second rule that could disagree with the
    # first, and a focus that fell outside its month would then either point at
    # a day nobody is collecting or, worse, silently pull one in.
    focused = frozenset(
        (watch.origin, watch.destination, watch.focus)
        for watch in watched
        if watch.focus and (watch.origin, watch.destination, watch.focus) in by_key
    )
    plan = due_now(
        list(by_key),
        store.last_checked(),
        moment,
        cadence=cadence,
        budget=spend,
        focused=focused,
    )

    queries = [by_key[(d.origin, d.destination, d.flight_date)] for d in plan if d.ready]
    report = await collect(
        queries,
        provider=provider,
        history=store,
        client=client,
        gap_seconds=gap_seconds,
    )
    skipped = [(what, "unreadable-month") for what in unreadable]
    skipped += [(f"{d.route} {d.flight_date}", d.reason) for d in plan if not d.ready]
    return CollectionReport(
        started_at=report.started_at,
        finished_at=report.finished_at,
        source=report.source,
        results=report.results,
        skipped=skipped,
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
