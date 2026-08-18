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
concurrent: a watchlist is tens of routes a day, so there is nothing to gain by
going faster and an address to lose by it.
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx

from app.adapters.fares.models import FareError, FareQuery, FareSnapshot
from app.adapters.fares.registry import DEFAULT_PROVIDER, FALLBACK_PROVIDER, fetch_with_fallback
from app.config import UPSTREAM_TIMEOUT_SECONDS
from app.services.fare_history import HISTORY, FareHistory

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
    #: Who actually answered. Not always the provider the pass asked for: a
    #: route that fell back carries the fallback's name, because a cached
    #: cheapest-of-the-day and a live itinerary list are different observations
    #: and the archive has to be able to say which one it holds.
    source: str | None = None
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
    #: The provider the pass asked for. Kept beside `sources` so a reader can
    #: work out that something fell back without knowing any provider's name —
    #: which is decision 8.3's whole point, and the page is a caller like any
    #: other.
    primary: str
    #: Every provider that actually answered during the pass, in the order they
    #: were first used. A list rather than a single name because a pass can be
    #: served by both, and "via google-flights" over a report that half came
    #: from somewhere else is the kind of true-sounding summary this feature
    #: keeps having to refuse.
    sources: list[str]
    results: list[RouteResult]

    @property
    def collected(self) -> int:
        return sum(1 for result in self.results if result.ok)

    @property
    def failed(self) -> int:
        return sum(1 for result in self.results if not result.ok)


def _now() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat()


async def collect(
    queries: list[FareQuery],
    *,
    provider: str = DEFAULT_PROVIDER,
    fallback: str | None = FALLBACK_PROVIDER,
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
            results.append(await _collect_one(session, query, provider, fallback, store))
    finally:
        if owned:
            await session.aclose()

    used: list[str] = []
    for result in results:
        if result.source and result.source not in used:
            used.append(result.source)

    report = CollectionReport(
        started_at=started_at,
        finished_at=_now(),
        primary=provider,
        sources=used,
        results=results,
    )
    logger.info(
        "fare collection finished: %d collected, %d failed", report.collected, report.failed
    )
    return report


async def _collect_one(
    client: httpx.AsyncClient,
    query: FareQuery,
    provider: str,
    fallback: str | None,
    store: FareHistory,
) -> RouteResult:
    def outcome(
        *,
        ok: bool,
        source: str | None = None,
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
            source=source,
            offers=offers,
            cheapest=cheapest,
            currency=currency,
            error_code=error_code,
            error_message=error_message,
        )

    try:
        answered_by, offers = await fetch_with_fallback(
            client, query, provider=provider, fallback=fallback
        )
    except FareError as error:
        logger.warning("fare collection refused %s: %s", query.route, error.message)
        return outcome(ok=False, error_code=error.code, error_message=error.message)

    snapshot = FareSnapshot(
        captured_at=_now(),
        source=answered_by,
        origin=query.origin,
        destination=query.destination,
        flight_date=query.flight_date,
        return_date=query.return_date,
        currency=query.currency.upper(),
        offers=offers,
    )
    try:
        store.append(snapshot)
    except OSError as error:
        # The fetch succeeded and the archive did not. Reported as a failure
        # because from the caller's side nothing was collected.
        return outcome(ok=False, error_code="write-failed", error_message=str(error))

    cheapest = snapshot.cheapest
    return outcome(
        ok=True,
        source=answered_by,
        offers=len(offers),
        cheapest=cheapest.price if cheapest else None,
        currency=snapshot.currency,
    )
