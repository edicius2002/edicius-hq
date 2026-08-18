"""
One collection pass over the watched routes.

Framework-free on purpose. The router calls it, `scripts/fares-collect.py`
calls it, and a scheduled job somewhere else would call it the same way — the
plan's runner decision is "local now, elsewhere later", and the way to keep
that cheap is to have the thing being run own no assumptions about who runs it.

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
from app.services.fare_schedule import due_now

logger = logging.getLogger(__name__)

# Seconds between upstream requests. Slow enough to look like a person browsing,
# fast enough that a twenty-route watchlist finishes in a couple of minutes.
REQUEST_GAP_SECONDS = 6.0


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
    #: due yet, departed, past the horizon, or over the day's budget. Reported
    #: rather than dropped, for the same reason a refusal is (8.8, 8.41): a
    #: pass that silently skips half a watchlist looks like a healthy one.
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


async def collect_due(
    watched: list[FareQuery],
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

    This is what a scheduler runs every few minutes: it asks the archive when
    each departure was last looked at, applies the cadence for how far away it
    is, and polls the ones whose turn has come. Everything it decides not to
    poll comes back in `skipped` with the reason, so a pass that does nothing
    can still say why it did nothing.
    """
    store = history if history is not None else HISTORY
    moment = now if now is not None else datetime.now(UTC)
    spend = budget if budget is not None else daily_request_budget()

    by_key = {(q.origin, q.destination, q.flight_date): q for q in watched}
    plan = due_now(
        list(by_key),
        store.last_checked(),
        moment,
        cadence=cadence,
        budget=spend,
    )

    queries = [by_key[(d.origin, d.destination, d.flight_date)] for d in plan if d.ready]
    report = await collect(
        queries,
        provider=provider,
        history=store,
        client=client,
        gap_seconds=gap_seconds,
    )
    skipped = [(f"{d.route} {d.flight_date}", d.reason) for d in plan if not d.ready]
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
        outcome="changed" if changed else "unchanged",
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
