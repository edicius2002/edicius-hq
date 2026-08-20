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
from pydantic import BaseModel, Field, model_validator

from app.adapters.fares.models import (
    FareError,
    FareInsights,
    FareOffer,
    FareQuery,
    FareSnapshot,
)
from app.adapters.fares.registry import DEFAULT_PROVIDER, PROVIDERS, fetch_offers, normalize_code
from app.config import CALENDAR_POLL_MINUTES, UPSTREAM_TIMEOUT_SECONDS
from app.services import airport_search
from app.services.calendar_job import CALENDAR_RUNNER, CalendarPass
from app.services.collection_job import RUNNER, CollectionPass
from app.services.fare_calendar import CALENDAR
from app.services.fare_collector import FareWatch
from app.services.fare_history import HISTORY

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/fares", tags=["fares"])

# How many watched months one collect call may carry. A year of them is already
# more than anyone plans, and the bound that actually matters is the one below.
MAX_COLLECT_MONTHS = 12

# There is deliberately no per-call request ceiling here any more — 12.210.
#
# There used to be, and it was forty, and forty was the browser's five-minute
# deadline read backwards rather than a judgement about the upstream: forty
# paced requests is four minutes, leaving the rest of the five for the requests
# themselves. Under 12.110 the owner's two watched months expand to sixty-two
# departures, so the cap meant a full manual refresh took two presses with a
# person in between — a limit imposed by how long a `fetch` waits, on a pass
# that no longer makes anyone wait.
#
# What bounds a pass now is `daily_request_budget()`, which `collect_due` falls
# back to and which is what the bound should always have been. Note, as
# `collect_due` already does, that nothing carries spend from one pass to the
# next, so that budget is enforced per pass rather than per day; that gap
# predates this and is not closed here.

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
    """
    One day of the provider's own history. Rounded, cheapest only.

    `flightDate` is the departure the figure was quoted for — 12.171. A watched
    month brings back thirty-one of these series at once, and without it the
    client holds 1,914 rows it cannot separate: the same observation date
    appears once per departure, so `date` alone is not a key and the difference
    the client actually wants — how far ahead of departure the price was seen —
    is not computable at all.
    """

    #: `YYYY-MM-DD`. Which departure this figure priced.
    flightDate: str
    #: `YYYY-MM-DD`. When it was priced.
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
    """
    One watched route as the client holds it: a city pair, a month, and
    optionally one day inside it.

    No `returnDate`, and no `flightDate` — 12.110. The client no longer knows
    which departures exist inside a month, and it should not: expanding one is
    the collector's job because only the collector can also say which of the
    expanded days it decided to leave alone, and why.

    `focusDate` is the exception that proves it, and it is not the client
    telling the collector what to fetch — 12.130. The month is still expanded
    whole and every day of it still gets its own rate. The focus says which one
    of those days the reader actually means to take, which matters for exactly
    one thing: when the budget cannot cover them all, that is the one kept
    (12.134).
    """

    origin: str = Field(..., min_length=3, max_length=3)
    destination: str = Field(..., min_length=3, max_length=3)
    #: `YYYY-MM`. Validated here rather than in the collector so a typo is a
    #: 422 the client can show, not a month that silently expands to nothing.
    month: str = Field(..., pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    #: `YYYY-MM-DD` inside `month`, or absent.
    focusDate: str | None = Field(None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    currency: str = "USD"

    @model_validator(mode="after")
    def _focus_is_inside_the_month(self) -> "RouteBody":
        """
        A focus outside its own month is a 422, not a quiet drop.

        The stored document cannot hold one — the web normalizer drops it on
        read, because a document that fails to load is worse than a route with
        no focus. Nothing on the client can then *send* one, so one arriving
        here is a bug in a caller and the useful thing to do with it is say so.
        Dropping it silently would leave the pass keeping the wrong departure
        with nothing anywhere recording why.
        """
        if self.focusDate is not None and not self.focusDate.startswith(f"{self.month}-"):
            raise ValueError(f"focusDate {self.focusDate!r} is not inside month {self.month!r}")
        return self


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
    """
    A collection pass, whether or not it has finished — 12.210.

    One document answers both the press that starts a pass and every poll that
    follows it. Two shapes were the obvious alternative and would have been
    worse: the client would then have to know which of them it was holding,
    and the interesting moment — a pass half-way through, with four results in
    and fifty-eight to go — is exactly the one neither shape describes on its
    own.

    Everything a finished pass used to say it still says. `results` and
    `skipped` carry the same things they always did, which is what lets the
    client's summary of a finished pass stay the function it already was.
    """

    #: `idle` before anything has ever run, then `running`, then `finished` or
    #: `failed`. `failed` is the pass falling over, not a route being refused —
    #: a refused route travels in `results` with its reason (8.8, 8.41).
    state: str
    #: `null` only while `state` is `idle`.
    startedAt: str | None
    #: `null` until the pass ends.
    finishedAt: str | None
    source: str
    #: What this pass covers, as `"ARI-SCL 2027-03"`. A press whose own route is
    #: missing from here was answered with a pass that was already running
    #: rather than served with one of its own, and the control that pressed has
    #: no other way to tell.
    watching: list[str]
    #: How many departures the pass means to poll in total. `null` until the
    #: plan is settled, which is a different fact from zero.
    polling: int | None
    #: How many of them have come back so far. Equal to `len(results)`, named
    #: because a progress bar wants a number and not a list length.
    completed: int
    collected: int
    changed: int
    failed: int
    results: list[RouteResultModel]
    # Departures deliberately not polled and why. A pass that silently skips
    # half a watchlist reads exactly like a healthy one.
    skipped: list[SkippedModel]
    #: Why the pass fell over, when it did.
    error: str | None


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


#: What `GET /collect` answers before anything has ever been collected. A pass
#: that has never run is a fact, and 404 would make the client special-case an
#: error for the ordinary state of a fresh install.
IDLE = CollectResponse(
    state="idle",
    startedAt=None,
    finishedAt=None,
    source=DEFAULT_PROVIDER,
    watching=[],
    polling=None,
    completed=0,
    collected=0,
    changed=0,
    failed=0,
    results=[],
    skipped=[],
    error=None,
)


def _pass_model(running: CollectionPass) -> CollectResponse:
    report = running.as_report()
    return CollectResponse(
        state=running.state,
        startedAt=running.started_at,
        finishedAt=running.finished_at,
        source=running.source,
        watching=list(running.watching),
        polling=running.polling,
        completed=running.completed,
        collected=report.collected,
        changed=report.changed,
        failed=report.failed,
        error=running.error,
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


def _watch_from(body: RouteBody) -> FareWatch:
    return FareWatch(
        origin=normalize_code(body.origin),
        destination=normalize_code(body.destination),
        month=body.month,
        currency=body.currency.upper(),
        focus=body.focusDate,
    )


@router.get("/history", response_model=HistoryResponse)
def get_history(
    origin: str = Query(..., min_length=3, max_length=3),
    destination: str = Query(..., min_length=3, max_length=3),
    departure: str | None = Query(
        None,
        min_length=7,
        max_length=10,
        description=(
            "Which departures the baseline and the health figures cover, as a "
            "prefix: 2027-03 for a watched month, 2027-03-09 for one day. "
            "Snapshots come back for the whole city pair either way."
        ),
    ),
    since: str | None = Query(None, description="Inclusive capturedAt prefix, e.g. 2026-08"),
    until: str | None = Query(None, description="Inclusive capturedAt prefix"),
) -> HistoryResponse:
    origin, destination = normalize_code(origin), normalize_code(destination)
    snapshots = HISTORY.read(origin, destination, since=since, until=until)
    # Narrowed to the same departures the baseline is: a route watched across
    # two months would otherwise report April's looks under March's heading.
    checks = HISTORY.checks(origin, destination, departure)
    known = HISTORY.airports()
    return HistoryResponse(
        origin=origin,
        destination=destination,
        snapshots=[_snapshot_model(snapshot) for snapshot in snapshots],
        baseline=[
            PricePointModel(flightDate=point.flight_date, date=point.date, price=point.price)
            for point in HISTORY.read_baseline(origin, destination, departure)
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


class CalendarPointModel(BaseModel):
    """
    One departure date and the cheapest fare on it.

    `price` is `null` when the provider answered about the date and had nothing
    to sell. A date absent from the list altogether was never answered for —
    the two are different facts and the window below is what tells them apart.
    """

    departureDate: str
    price: float | None


class CalendarCurveModel(BaseModel):
    capturedAt: str
    source: str
    currency: str
    #: The window that was asked for, so a missing date reads as a gap in the
    #: answer rather than as a date nobody wanted.
    fromDate: str
    toDate: str
    prices: list[CalendarPointModel]


class CalendarResponse(BaseModel):
    origin: str
    destination: str
    #: The most recent curve, or `null` when this pair has never been collected.
    latest: CalendarCurveModel | None
    health: WatchHealthModel


@router.get("/calendar", response_model=CalendarResponse)
def get_calendar(
    origin: str = Query(..., min_length=3, max_length=3),
    destination: str = Query(..., min_length=3, max_length=3),
) -> CalendarResponse:
    """
    What every departure date out to the horizon costs, as last collected.

    The counterpart to `/history`, and deliberately a different endpoint rather
    than a field on it. `/history` answers "what has this route done over time"
    for the month somebody watches; this answers "which day of which month is
    cheap" for all eleven they do not. One is a series of boards, the other is
    one number a day with no carrier and no times, and serving them together
    would invite a client to draw them on one axis.

    The latest curve only. The store keeps every one that was ever different,
    so a series of curves can be served later without collecting anything
    again — but nothing today reads more than the newest, and three hundred
    points times a year of curves is not a payload to ship on speculation.
    """
    origin, destination = normalize_code(origin), normalize_code(destination)
    curve = CALENDAR.latest(origin, destination)
    checks = CALENDAR.checks(origin, destination)
    return CalendarResponse(
        origin=origin,
        destination=destination,
        latest=(
            None
            if curve is None
            else CalendarCurveModel(
                capturedAt=curve.captured_at,
                source=curve.source,
                currency=curve.currency,
                fromDate=curve.start,
                toDate=curve.end,
                prices=[
                    CalendarPointModel(departureDate=point.departure_date, price=point.price)
                    for point in curve.prices
                ],
            )
        ),
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


@router.post("/collect", response_model=CollectResponse, status_code=status.HTTP_202_ACCEPTED)
async def collect_routes(
    body: CollectBody,
    provider: str = Query(DEFAULT_PROVIDER),
) -> CollectResponse:
    """
    Start collecting the departures inside these watched months that are due.

    **This returns as soon as the pass has started, not when it has finished**
    — 12.210, superseding the synchronous half of 12.90. It answers 202 and a
    `running` document; `GET /collect` is where the rest of the story is. The
    pass itself is unchanged in every respect that touches the upstream: same
    order, same schedule, same one-at-a-time loop at the same gap.

    What it buys is that a pass no longer has to fit inside a browser's
    patience. `MAX_COLLECT_REQUESTS` was forty because five minutes of `fetch`
    divided by six seconds is forty, which made a sixty-two-departure watchlist
    a two-press job for a reason that had nothing to do with fares. There is no
    ceiling here now beyond the request budget.

    **This still runs the schedule, where it once bypassed it** — 12.111,
    unchanged. The press does everything that would tell the reader something
    new and declines the departures whose last look is younger than their own
    interval, saying so on the row. See 12.212 for why that is still the
    behaviour now that a press is cheap to leave running.

    A press that arrives while a pass is running gets that pass rather than a
    second one, because the gap in `fare_collector` paces a loop and two loops
    would halve it without anyone deciding to.
    """
    if provider not in PROVIDERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown provider {provider!r}")
    if not body.routes:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No routes to collect")
    if len(body.routes) > MAX_COLLECT_MONTHS:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Too many months in one call; the limit is {MAX_COLLECT_MONTHS}",
        )

    return _pass_model(
        RUNNER.start(
            [_watch_from(route) for route in body.routes],
            provider=provider,
            client=get_client(),
        )
    )


@router.get("/collect", response_model=CollectResponse)
def collect_progress() -> CollectResponse:
    """
    How the current pass is getting on, or how the last one ended.

    The same document `POST /collect` answers with, which is the whole point:
    a client that can read the press's answer can read this one, and the
    summary it builds for a finished pass is the function it already had.
    """
    running = RUNNER.current()
    return IDLE if running is None else _pass_model(running)


# --------------------------------------------------------- collecting a curve --


class CalendarCollectBody(BaseModel):
    """
    One city pair to collect the whole horizon for.

    No month, and that is the difference from `RouteBody` rather than an
    omission: a curve covers every departure date out to the booking horizon in
    one observation, so the month a reader happens to watch is not a key here
    and naming one would suggest it narrowed something.
    """

    origin: str = Field(..., min_length=3, max_length=3)
    destination: str = Field(..., min_length=3, max_length=3)
    #: Absent means USD, matching `RouteBody`. Optional rather than defaulted in
    #: the schema because the caller adding a route may genuinely not have
    #: picked one yet, and `null` says that where `"USD"` would claim it did.
    currency: str | None = None


class CalendarResultModel(BaseModel):
    """
    What one city pair's curve collection came back with.

    `dates` and `priced` are two figures rather than one because they answer
    different questions: how much of the horizon was answered for at all, and
    how much of it has anything to sell. A year where every day came back
    priceless is a real answer and reads nothing like a year we never reached.
    """

    origin: str
    destination: str
    ok: bool
    #: Whether this look wrote a curve. False when nothing in the year moved,
    #: which on a daily cadence is most looks.
    changed: bool
    dates: int
    priced: int
    cheapest: float | None
    cheapestOn: str | None
    currency: str | None
    #: Upstream requests spent on this pair. Two, unless a window was refused
    #: before the second one was asked for.
    requests: int
    # Present only on a refusal. A pair that failed travels beside the ones
    # that worked and says why — decisions 8.8 and 8.41.
    errorCode: str | None
    errorMessage: str | None


class CalendarCollectResponse(BaseModel):
    """
    A calendar pass, whether or not it has finished.

    Deliberately the same shape as `CollectResponse` minus the fields a curve
    has no meaning for, so a client that already reads one press's answer reads
    this one the same way. `polling` is the notable absence: a board pass polls
    dozens of departures and a progress bar wants a denominator, whereas a
    calendar pass is one city pair and two requests, so the only figure it
    could report is one.
    """

    #: `idle` before anything has ever run, then `running`, then `finished` or
    #: `failed`. `failed` is the pass falling over, not a provider refusing a
    #: pair — a refused pair travels in `results` with its reason (8.8, 8.41).
    state: str
    #: `null` only while `state` is `idle`.
    startedAt: str | None
    #: `null` until the pass ends.
    finishedAt: str | None
    source: str
    #: What this pass covers, as `"LIM-SCL"`. A press whose own pair is missing
    #: from here was answered with a pass that was already running rather than
    #: served with one of its own, and the control that pressed has no other
    #: way to tell.
    watching: list[str]
    #: How many pairs have come back so far. Equal to `len(results)`, named
    #: because a caller wants a number and not a list length.
    completed: int
    collected: int
    changed: int
    failed: int
    results: list[CalendarResultModel]
    # Pairs deliberately not polled and why — most often `not-due`, because a
    # curve is collected once a day and a route added twice in an afternoon is
    # asking for the second one for nothing. A pass that silently skipped them
    # would read exactly like one that collected them.
    skipped: list[SkippedModel]
    #: Why the pass fell over, when it did.
    error: str | None


#: What `GET /calendar/collect` answers before any curve has ever been
#: collected. Same reasoning as `IDLE` above: never having run is a fact about a
#: fresh install, and 404 would make the client special-case an error to
#: describe it.
CALENDAR_IDLE = CalendarCollectResponse(
    state="idle",
    startedAt=None,
    finishedAt=None,
    source=DEFAULT_PROVIDER,
    watching=[],
    completed=0,
    collected=0,
    changed=0,
    failed=0,
    results=[],
    skipped=[],
    error=None,
)


def _calendar_pass_model(running: CalendarPass) -> CalendarCollectResponse:
    report = running.as_report()
    return CalendarCollectResponse(
        state=running.state,
        startedAt=running.started_at,
        finishedAt=running.finished_at,
        source=running.source,
        watching=list(running.watching),
        completed=running.completed,
        collected=report.collected,
        changed=report.changed,
        failed=report.failed,
        error=running.error,
        skipped=[SkippedModel(what=what, reason=reason) for what, reason in report.skipped],
        results=[
            CalendarResultModel(
                origin=result.origin,
                destination=result.destination,
                ok=result.ok,
                changed=result.changed,
                dates=result.dates,
                priced=result.priced,
                cheapest=result.cheapest,
                cheapestOn=result.cheapest_on,
                currency=result.currency,
                requests=result.requests,
                errorCode=result.error_code,
                errorMessage=result.error_message,
            )
            for result in report.results
        ],
    )


# Declared after `GET /calendar`, and the two do not collide: both are literal
# paths with no parameter in them, so FastAPI matches `/calendar/collect`
# exactly and never reaches the shorter route. The pair is kept together and
# spelled out here because that stops being true the moment anyone adds a
# `/calendar/{something}` above it — a parameterised route declared first would
# swallow `collect` as its parameter and the failure would be a 422 about a
# route code, not a missing endpoint.
@router.post(
    "/calendar/collect",
    response_model=CalendarCollectResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def collect_calendar(
    body: CalendarCollectBody,
    provider: str = Query(DEFAULT_PROVIDER),
) -> CalendarCollectResponse:
    """
    Start collecting this city pair's whole-horizon curve.

    **This returns as soon as the pass has started, not when it has finished.**
    It answers 202 and a `running` document; `GET /calendar/collect` is where
    the rest of the story is. The pass itself is the same one the scheduled
    script runs — same windows, same order, same gap between requests.

    What it is for is the moment a route is added to the watchlist. Until a
    curve exists the eleven months the reader did not pick are blank, and the
    only thing that has ever filled them is a command line on a timer, so the
    chart stayed empty until the next scheduled pass happened to run. This lets
    the press that adds the route ask for its curve.

    **It still runs the schedule rather than bypassing it, with one exception.**
    A pair whose curve was collected within `CALENDAR_POLL_MINUTES` comes back
    in `skipped` as `not-due` and no request is spent, which is the correct
    answer to "collect this again" ten minutes after collecting it — a fare
    eleven months out moves by a median 1.7% a day, so the second look would
    cost two requests to confirm the first. The row says so instead of the pass
    quietly doing nothing, so a caller can tell a declined press from a broken
    one.

    The exception is a pair with **no curve on disk at all**, which is always
    due. The cadence is measured from the last *look*, not from the last curve,
    and a look that failed counts — so the first collection of a brand-new route
    refusing once left that route with nothing to draw and no second attempt for
    a day, which was observed happening against the live provider the first time
    this endpoint was pointed at it. Deciding it here rather than inside `due`
    is deliberate: the scheduled pass is right to leave a failing route alone
    until tomorrow, because nobody is waiting for it. Here somebody just added
    the route and is looking at the empty chart. Each attempt still costs a
    human pressing "Add route", so this cannot loop.

    A press that arrives while a pass is running gets that pass rather than a
    second one, because the gap in `fare_collector` paces a loop and two loops
    would halve it without anyone deciding to.
    """
    if provider not in PROVIDERS:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Unknown provider {provider!r}")

    watch = FareWatch(
        origin=normalize_code(body.origin),
        destination=normalize_code(body.destination),
        # A calendar pass is keyed by city pair and never reads the month —
        # `collect_calendars` folds every watch on a pair into one collection
        # because one curve already covers every month. Empty rather than
        # today's month, which would be a fact nobody stated and which would
        # read, to anyone debugging, as though the horizon started there.
        # A second watch type carrying only a pair was the alternative and
        # would have bought a class whose sole difference is a field this
        # collector already ignores.
        month="",
        currency=(body.currency or "USD").upper(),
    )
    # Nothing on disk means nothing for the cadence to protect, so the pass is
    # allowed regardless of when we last looked. `due` compares against
    # `every_minutes`, and zero makes every elapsed time long enough.
    nothing_yet = CALENDAR.latest(watch.origin, watch.destination) is None
    return _calendar_pass_model(
        CALENDAR_RUNNER.start(
            [watch],
            provider=provider,
            client=get_client(),
            every_minutes=0 if nothing_yet else CALENDAR_POLL_MINUTES,
        )
    )


@router.get("/calendar/collect", response_model=CalendarCollectResponse)
def collect_calendar_progress() -> CalendarCollectResponse:
    """
    How the current calendar pass is getting on, or how the last one ended.

    The same document `POST /calendar/collect` answers with, for the same
    reason the board pair share theirs: a client that can read the press's
    answer can read this one without knowing which of the two it holds.
    """
    running = CALENDAR_RUNNER.current()
    return CALENDAR_IDLE if running is None else _calendar_pass_model(running)
