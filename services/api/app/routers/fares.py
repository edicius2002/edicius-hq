"""
Airfare endpoints — Path B.

Prices are public data with a cache and an archive in front of them, so none of
this is user state: the watched routes themselves live in the KV store under
`airfare-routes`, and nothing here reads or writes them. The client sends the
routes it wants collected; this router does not decide which they are.

Wire shapes are camelCase, matching `app.routers.market` and the TypeScript
types that mirror them.
"""

import logging

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.adapters.fares.models import (
    FareError,
    FareInsights,
    FareOffer,
    FareQuery,
    FareSnapshot,
)
from app.adapters.fares.registry import DEFAULT_PROVIDER, PROVIDERS, fetch_offers, normalize_code
from app.config import UPSTREAM_TIMEOUT_SECONDS
from app.services import airport_search
from app.services.fare_collector import CollectionReport, collect
from app.services.fare_history import HISTORY

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/fares", tags=["fares"])

# How many routes one collect call may carry. Each is a paced upstream request,
# so this bounds how long a single call can hold a connection open as much as it
# bounds the load — a hundred routes would be ten minutes of sleeping.
MAX_COLLECT_ROUTES = 40

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS, follow_redirects=True)
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class OfferModel(BaseModel):
    airline: str
    airlineName: str | None
    flightNumber: str | None
    # Local wall clock at the airport, ISO 8601 with no zone. The client must
    # not treat it as UTC; see `FareOffer` for why there is no offset to give.
    departureAt: str
    arrivalAt: str | None
    transfers: int
    durationMinutes: int | None
    price: float
    currency: str


class InsightsModel(BaseModel):
    """What the provider says this search usually costs."""

    typical: float | None
    usualLow: float | None
    usualHigh: float | None


class SnapshotModel(BaseModel):
    capturedAt: str
    source: str
    origin: str
    destination: str
    flightDate: str
    returnDate: str | None
    currency: str
    insights: InsightsModel | None
    offers: list[OfferModel]


class PricePointModel(BaseModel):
    """One day of the provider's own history. Rounded, cheapest only."""

    date: str
    price: float


class AirportModel(BaseModel):
    """Where an IATA code is. Collected free with every search."""

    code: str
    name: str | None
    city: str | None
    country: str | None
    latitude: float
    longitude: float


class WatchHealthModel(BaseModel):
    """
    Whether the collector has been looking, separately from what it found.

    A stretch of the archive with no snapshots means either no price movement
    or no collector, and a series whose gaps are ambiguous is a series nobody
    should trust. These come from the heartbeats, which are written on every
    poll whatever the outcome.
    """

    lastCheckedAt: str | None
    checks: int
    changes: int
    errors: int


class HistoryResponse(BaseModel):
    origin: str
    destination: str
    snapshots: list[SnapshotModel]
    # The provider's own daily series, kept separate from our snapshots
    # because it is one rounded integer a day with no airline and no time —
    # context for the series rather than part of it.
    baseline: list[PricePointModel]
    health: WatchHealthModel
    # Only the two ends of this route. The client draws a line between them;
    # it has no use for an atlas.
    airports: list[AirportModel]


class SearchResponse(BaseModel):
    origin: str
    destination: str
    flightDate: str
    returnDate: str | None
    source: str
    offers: list[OfferModel]


class RouteBody(BaseModel):
    origin: str = Field(..., min_length=3, max_length=3)
    destination: str = Field(..., min_length=3, max_length=3)
    flightDate: str = Field(..., min_length=10, max_length=10)
    returnDate: str | None = None
    currency: str = "USD"


class CollectBody(BaseModel):
    routes: list[RouteBody]


class RouteResultModel(BaseModel):
    origin: str
    destination: str
    flightDate: str
    returnDate: str | None
    ok: bool
    # Whether this look wrote a snapshot. False when the board had not moved,
    # which at a half-hourly cadence is most looks.
    changed: bool
    # Days of provider history folded in — non-zero essentially only the first
    # time a departure is watched.
    seeded: int
    offers: int
    cheapest: float | None
    currency: str | None
    # Present only on a refusal. A route that failed travels beside the ones
    # that worked and says why — decisions 8.8 and 8.41.
    errorCode: str | None
    errorMessage: str | None


class SkippedModel(BaseModel):
    what: str
    reason: str


class CollectResponse(BaseModel):
    startedAt: str
    finishedAt: str
    source: str
    collected: int
    changed: int
    failed: int
    results: list[RouteResultModel]
    # Departures deliberately not polled and why. A pass that silently skips
    # half a watchlist reads exactly like a healthy one.
    skipped: list[SkippedModel]


def _offer_model(offer: FareOffer) -> OfferModel:
    return OfferModel(
        airline=offer.airline,
        airlineName=offer.airline_name,
        flightNumber=offer.flight_number,
        departureAt=offer.departure_at,
        arrivalAt=offer.arrival_at,
        transfers=offer.transfers,
        durationMinutes=offer.duration_minutes,
        price=offer.price,
        currency=offer.currency,
    )


def _insights_model(insights: FareInsights | None) -> InsightsModel | None:
    if insights is None:
        return None
    return InsightsModel(
        typical=insights.typical,
        usualLow=insights.usual_low,
        usualHigh=insights.usual_high,
    )


def _snapshot_model(snapshot: FareSnapshot) -> SnapshotModel:
    return SnapshotModel(
        capturedAt=snapshot.captured_at,
        insights=_insights_model(snapshot.insights),
        source=snapshot.source,
        origin=snapshot.origin,
        destination=snapshot.destination,
        flightDate=snapshot.flight_date,
        returnDate=snapshot.return_date,
        currency=snapshot.currency,
        offers=[_offer_model(offer) for offer in snapshot.offers],
    )


def _report_model(report: CollectionReport) -> CollectResponse:
    return CollectResponse(
        startedAt=report.started_at,
        finishedAt=report.finished_at,
        source=report.source,
        collected=report.collected,
        changed=report.changed,
        failed=report.failed,
        skipped=[SkippedModel(what=what, reason=reason) for what, reason in report.skipped],
        results=[
            RouteResultModel(
                origin=result.origin,
                destination=result.destination,
                flightDate=result.flight_date,
                returnDate=result.return_date,
                ok=result.ok,
                changed=result.changed,
                seeded=result.seeded,
                offers=result.offers,
                cheapest=result.cheapest,
                currency=result.currency,
                errorCode=result.error_code,
                errorMessage=result.error_message,
            )
            for result in report.results
        ],
    )


def _query_from(body: RouteBody) -> FareQuery:
    return FareQuery(
        origin=normalize_code(body.origin),
        destination=normalize_code(body.destination),
        flight_date=body.flightDate,
        return_date=body.returnDate,
        currency=body.currency.upper(),
    )


@router.get("/history", response_model=HistoryResponse)
def get_history(
    origin: str = Query(..., min_length=3, max_length=3),
    destination: str = Query(..., min_length=3, max_length=3),
    flightDate: str | None = Query(
        None,
        min_length=10,
        max_length=10,
        description="Which departure's baseline to return; snapshots are unfiltered",
    ),
    since: str | None = Query(None, description="Inclusive capturedAt prefix, e.g. 2026-08"),
    until: str | None = Query(None, description="Inclusive capturedAt prefix"),
) -> HistoryResponse:
    origin, destination = normalize_code(origin), normalize_code(destination)
    snapshots = HISTORY.read(origin, destination, since=since, until=until)
    checks = HISTORY.checks(origin, destination)
    known = HISTORY.airports()
    return HistoryResponse(
        origin=origin,
        destination=destination,
        snapshots=[_snapshot_model(snapshot) for snapshot in snapshots],
        baseline=[
            PricePointModel(date=point.date, price=point.price)
            for point in HISTORY.read_baseline(origin, destination, flightDate)
        ],
        airports=[
            AirportModel(
                code=airport.code,
                name=airport.name,
                city=airport.city,
                country=airport.country,
                latitude=airport.latitude,
                longitude=airport.longitude,
            )
            for code in (origin, destination)
            if (airport := known.get(code)) is not None
        ],
        health=WatchHealthModel(
            lastCheckedAt=str(checks[-1].get("at")) if checks else None,
            checks=len(checks),
            changes=sum(1 for row in checks if row.get("outcome") == "changed"),
            errors=sum(1 for row in checks if row.get("outcome") == "error"),
        ),
    )


class AirportsResponse(BaseModel):
    airports: list[AirportModel]


@router.get("/airports", response_model=AirportsResponse)
def get_airports() -> AirportsResponse:
    """
    Every airport the archive has ever seen, with coordinates.

    The map draws one arc per watched route, so it needs both ends of all of
    them at once — the per-route history call only knows about its own two.
    This is a handful of entries collected free from the searches themselves,
    which is why there is no atlas bundled anywhere in this repository.
    """
    return AirportsResponse(
        airports=[
            AirportModel(
                code=airport.code,
                name=airport.name,
                city=airport.city,
                country=airport.country,
                latitude=airport.latitude,
                longitude=airport.longitude,
            )
            for airport in sorted(HISTORY.airports().values(), key=lambda a: a.code)
        ]
    )


class AirportMatchModel(BaseModel):
    code: str
    city: str
    country: str
    name: str


class AirportSearchResponse(BaseModel):
    query: str
    matches: list[AirportMatchModel]


@router.get("/airports/search", response_model=AirportSearchResponse)
def search_airports(
    q: str = Query("", description="What has been typed so far"),
    limit: int = Query(airport_search.DEFAULT_LIMIT, ge=1, le=25),
) -> AirportSearchResponse:
    """
    Airports matching what is being typed, best match first.

    Separate from `/airports`, which lists only what the archive has actually
    collected. This one searches every airport with scheduled service, so a
    route can be added to somewhere nobody has watched yet.

    Server-side because the table is 71 kB gzipped: bundling it would roughly
    double the airfare page for a feature most visits never touch, and it
    costs about a kilobyte a keystroke here.
    """
    return AirportSearchResponse(
        query=q,
        matches=[
            AirportMatchModel(
                code=match.code, city=match.city, country=match.country, name=match.name
            )
            for match in airport_search.search(q, limit)
        ],
    )


@router.get("/search", response_model=SearchResponse)
async def search(
    origin: str = Query(..., min_length=3, max_length=3),
    destination: str = Query(..., min_length=3, max_length=3),
    flightDate: str = Query(..., min_length=10, max_length=10),
    returnDate: str | None = Query(None, min_length=10, max_length=10),
    currency: str = Query("USD", min_length=3, max_length=3),
    provider: str = Query(DEFAULT_PROVIDER),
) -> SearchResponse:
    """
    One live look at a route. Nothing is archived.

    Separate from `/collect` on purpose: adding a route to the watchlist should
    be able to show what it costs right now without putting an off-schedule
    point into a series whose whole value is being evenly spaced.
    """
    if provider not in PROVIDERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown provider {provider!r}")

    query = FareQuery(
        origin=normalize_code(origin),
        destination=normalize_code(destination),
        flight_date=flightDate,
        return_date=returnDate,
        currency=currency.upper(),
    )
    try:
        offers = await fetch_offers(get_client(), query, provider=provider)
    except FareError as error:
        # 404 for "there are no flights", 502 for "the provider let us down".
        # The client renders those differently and cannot if both are 500.
        code = (
            status.HTTP_404_NOT_FOUND if error.code == "no-offers" else status.HTTP_502_BAD_GATEWAY
        )
        raise HTTPException(code, detail={"code": error.code, "message": error.message}) from error

    return SearchResponse(
        origin=query.origin,
        destination=query.destination,
        flightDate=query.flight_date,
        returnDate=query.return_date,
        source=provider,
        offers=[_offer_model(offer) for offer in offers],
    )


@router.post("/collect", response_model=CollectResponse)
async def collect_routes(
    body: CollectBody,
    provider: str = Query(DEFAULT_PROVIDER),
) -> CollectResponse:
    if provider not in PROVIDERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown provider {provider!r}")
    if not body.routes:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No routes to collect")
    if len(body.routes) > MAX_COLLECT_ROUTES:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Too many routes in one call; the limit is {MAX_COLLECT_ROUTES}",
        )

    report = await collect(
        [_query_from(route) for route in body.routes],
        provider=provider,
        client=get_client(),
    )
    return _report_model(report)
