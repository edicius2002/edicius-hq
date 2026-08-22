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
from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.adapters.fares.models import (
    FareError,
    FareInsights,
    FareOffer,
    FareQuery,
    FareSnapshot,
)
from app.adapters.fares.registry import DEFAULT_PROVIDER, PROVIDERS, fetch_offers, normalize_code
from app.config import BUSIEST_DAY_ON_RECORD, CALENDAR_POLL_MINUTES, UPSTREAM_TIMEOUT_SECONDS
from app.services import airport_search
from app.services.calendar_job import CALENDAR_RUNNER, CalendarPass
from app.services.collection_job import RUNNER, CollectionPass
from app.services.fare_calendar import CALENDAR
from app.services.fare_collector import FareWatch
from app.services.fare_history import HISTORY
from app.services.fare_spend import read_spend
from app.services.pass_stream import CALENDAR_STREAM, COLLECTION_STREAM
from app.services.sse import KEEP_ALIVE, sse

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
# What replaced it was `daily_request_budget()` — a **day's** ceiling rather
# than a pass's, spent as one, with `app.services.fare_budget` keeping the
# running total on disk. That is still the mechanism and it still covers the
# calendar pass below, one address and one day; what changed is that the ceiling
# defaults to none, so a press buys the whole watchlist whenever it arrives and
# only an environment that sets a number brings back the day where it does not.
#
# So no count bounds a press. What does is the pacing and the pass lock, neither
# of which this endpoint can talk its way past: a press that arrives while a
# scheduled pass is running is told so and sends nothing, and one that gets
# through sends its requests three seconds apart like any other pass. Both are
# in `fare_budget`, which is also where the case for the count going away is
# argued against what those two actually protect.

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
    One watched route as the client holds it: a city pair and a month.

    No `returnDate`, and no `flightDate` — 12.110. The client no longer knows
    which departures exist inside a month, and it should not: expanding one is
    the collector's job because only the collector can also say which of the
    expanded days it decided to leave alone, and why.

    **And no `focusDate` either, since 12.266.** It was the one exception —
    12.130's day inside the month, which changed nothing about what was
    expanded and only decided which departure survived a truncated pass
    (12.134). The client has no focus to send now, so the field goes with it
    rather than staying as a parameter no caller sets in front of an ordering
    nothing can reach. A stale client that still sends the key gets it ignored,
    which is Pydantic's default for an unknown field and is the right answer
    here: the value would have changed only the order of a pass, and the pass
    now orders by distance, which is what 12.111 measured.
    """

    origin: str = Field(..., min_length=3, max_length=3)
    destination: str = Field(..., min_length=3, max_length=3)
    #: `YYYY-MM`. Validated here rather than in the collector so a typo is a
    #: 422 the client can show, not a month that silently expands to nothing.
    month: str = Field(..., pattern=r"^\d{4}-(0[1-9]|1[0-2])$")
    currency: str = "USD"


class CollectBody(BaseModel):
    routes: list[RouteBody]
    #: Poll every departure in the month whether or not its turn has come —
    #: `a-press-collects-the-month-it-is-on`, settling 12.212.
    #:
    #: **Default `False`, so the endpoint's ordinary behaviour is the schedule**
    #: (12.111) and this is a second way in rather than a change to the first. A
    #: caller that sends nothing gets exactly what it got before.
    #:
    #: **And it is refused unless `routes` holds exactly one.** That is the
    #: narrowing the whole decision turns on: 12.212 costed a press at
    #: sixty-two requests and a fifth of the day because it assumed a pass over
    #: the whole watchlist, and a press that can only ever name one route-month
    #: costs thirty-one at the very most. Enforcing it here rather than trusting
    #: the one caller is what makes that a property of the API instead of a
    #: habit of the client.
    force: bool = False


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
    One departure date, the cheapest fare on it, and when that fare was seen.

    `price` is `null` when the provider answered about the date and had nothing
    to sell. A date absent from the list altogether was never answered for —
    the two are different facts and the window below is what tells them apart.

    `observedAt` is not decoration. The horizon below is assembled from every
    curve on disk, so two prices side by side can be days apart in age, and a
    client that drew them alike would be showing a stale figure as today's.
    """

    departureDate: str
    price: float | None
    #: When this date's price was collected. Compare it against the horizon's
    #: own `capturedAt` to tell an inherited price from a fresh one.
    observedAt: str


class CalendarHorizonModel(BaseModel):
    """
    The whole booking horizon, assembled from every curve stored for the pair.

    Shaped exactly as one collected curve is — a window and one price per
    departure date inside it — and deliberately so: it is what a reader of the
    year wants and what this endpoint has always served. What it is not is a
    single observation, which is why every price carries its own stamp.
    """

    #: **The freshest price in `prices`**, and only that. It does not describe
    #: the dates around it — those carry their own `observedAt` — and a client
    #: that spreads this stamp over the whole window is claiming a freshness
    #: most of it may not have. See `FareCalendar.horizon` for why this reading
    #: was chosen over "the newest curve that contributed".
    capturedAt: str
    source: str
    currency: str
    #: The window this answer covers: the newest curve's near end, and the far
    #: end of whichever curve reached furthest. A date inside it and missing
    #: from `prices` was answered for by no collection at all.
    fromDate: str
    toDate: str
    prices: list[CalendarPointModel]


class CalendarResponse(BaseModel):
    origin: str
    destination: str
    #: Every departure date any stored curve answered for, or `null` when this
    #: pair has never been collected.
    #:
    #: This field was `latest` and held the newest curve alone. The name went
    #: with the behaviour rather than outliving it: a merged answer called
    #: "latest" would be telling a client that every price in it is the newest,
    #: which is the one thing this change exists to stop it believing.
    horizon: CalendarHorizonModel | None
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

    **One answer built from every stored curve, not the newest one served
    whole** — `a-curve-fills-what-newer-lost`. This used to be
    `CALENDAR.latest()`, and a curve can be shorter than the one before it:
    since 12.245 a refused far window is walked back and only the answered part
    is kept, so a collection that ran into a refusal took months off the chart
    while the longer curve sat on disk beside it. `FareCalendar.horizon` is
    where the merge and its refusals are argued; the payload is still one price
    per departure date and is bounded by the same window it always was, because
    the near end comes from the newest curve and old dates are not carried
    forward.

    Still one curve's worth of dates rather than a series of curves. Nothing
    here reads the history of a single date over time, and three hundred points
    times a year of collections is not a payload to ship on speculation.
    """
    origin, destination = normalize_code(origin), normalize_code(destination)
    horizon = CALENDAR.horizon(origin, destination)
    checks = CALENDAR.checks(origin, destination)
    return CalendarResponse(
        origin=origin,
        destination=destination,
        horizon=(
            None
            if horizon is None
            else CalendarHorizonModel(
                capturedAt=horizon.captured_at,
                source=horizon.source,
                currency=horizon.currency,
                fromDate=horizon.start,
                toDate=horizon.end,
                prices=[
                    CalendarPointModel(
                        departureDate=point.departure_date,
                        price=point.price,
                        observedAt=point.observed_at,
                    )
                    for point in horizon.prices
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

    **This runs the schedule unless the body says otherwise** — 12.111 for the
    default, `a-press-collects-the-month-it-is-on` for the exception, which
    settles 12.212. With no `force` the pass declines every departure whose last
    look is younger than its own interval and says so on the row, exactly as it
    has since 12.111. With `force`, one route-month's departures are all polled
    whatever the cadence would have said, because a reader who presses has
    decided they do not believe the last look and 21:04 answering `31 not-due`
    after a 14:41 pass is the complaint 12.212 reproduced.

    **What `force` does not buy is a bigger press.** It is refused with anything
    other than exactly one route, so the most it can cost is one month —
    thirty-one board requests, a twentieth of the day. That bound is the reason
    the cost objection in 12.212 does not carry: it was costing a pass over the
    whole watchlist.

    **And it buys nothing against the budget or the lock.** The pass still reads
    the day's ledger before every request and still stops at `over-budget`; it
    still takes the pass lock before it plans and still reports
    `another-pass-is-running` when a scheduled pass holds it. Both come back as
    ordinary skipped reasons the row already renders.

    A press that arrives while a pass is running gets that pass rather than a
    second one, because the gap in `fare_collector` paces a loop and two loops
    would halve it without anyone deciding to. That is also the guard a repeated
    press meets: the second click starts nothing.
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
    if body.force and len(body.routes) != 1:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            "A forced collection covers one route and one month; send exactly one route",
        )

    return _pass_model(
        RUNNER.start(
            [_watch_from(route) for route in body.routes],
            provider=provider,
            client=get_client(),
            force=body.force,
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
    return _current_pass()


def _current_pass() -> CollectResponse:
    """
    The pass document as it stands, for whoever is asking.

    Named because two endpoints now render it — the poll above and the stream
    below — and they must render the same thing. A stream that built its own
    view of a pass would be a second answer to the question `GET /collect`
    already answers, which is the drift the frame docstring is about.
    """
    running = RUNNER.current()
    return IDLE if running is None else _pass_model(running)


# Declared after `GET /collect`, and the two do not collide: both are literal
# paths with no parameter in them, so FastAPI matches `/collect/stream` exactly
# and never reaches the shorter route. See the note above `/calendar/collect`
# for what stops being true the moment anybody adds a parameterised sibling.
@router.get("/collect/stream")
async def stream_collection(request: Request) -> StreamingResponse:
    """
    A collection pass as it unfolds, pushed — `a-pass-is-pushed-not-polled`.

    The same shape as `/api/market/stream` and for the same reasons — 8.19:
    server-sent events rather than a socket, because this direction is the only
    one carrying anything and an `EventSource` reconnects by itself. Nothing in
    a frame names a provider (8.3); `source` is the same word `/collect` has
    always answered with.

    **What replaces what.** `GET /collect` used to be asked every two seconds by
    every row that had pressed. That poll is cheap — it reads memory and reaches
    no upstream — and it stays as the client's fallback, so this is an
    improvement rather than a dependency. What it could never do is the third
    thing: a pass is minutes long, the charts read `GET /history`, and that
    endpoint answers with **every** snapshot for the city pair — measured on this
    archive at 91 snapshots, ~327 kB, plus 1,846 baseline points at ~123 kB, and
    growing without bound. Polling *that* every two seconds to keep a chart fresh
    would trade a frozen page for 21 MB of refetching per four-minute pass, so
    the archive's queries were only ever refreshed when the pass ended — and a
    reader watching four minutes of nothing reloads the page, which is the
    complaint this exists to answer.

    **Two events, and both are documents this API already defines.**

    - `pass` carries `CollectResponse`, byte for byte the thing `GET /collect`
      answers with. The client's summary of a pass, its "whose pass is this"
      check and its progress bar are the functions they already were.
    - `snapshot` carries `SnapshotModel`, byte for byte an element of
      `HistoryResponse.snapshots`. It is sent only for a look that actually
      **wrote**, which on a half-hourly cadence is a minority of looks.

    Both are the existing models rather than thinner cousins, and that is the
    decision rather than an implementation detail. `tick_payload` in the market
    router is the same idea done the other way — a shape invented for the socket
    — and it drifted: the socket emitted an `EXTENDED` market state the browser
    had no branch for, because one question was being answered in two places. A
    frame that is the REST model cannot drift from the REST model.

    The first `pass` frame is sent before anything is waited for, so a tab that
    connects halfway through a pass is caught up rather than left waiting for
    the next departure — and a tab that connects to an idle machine is told so
    at once instead of sitting silent for twenty seconds.
    """

    async def events() -> AsyncIterator[str]:
        # Subscribed *before* the catch-up frame is rendered, so a departure
        # that lands between the two is queued rather than lost. The `with` is
        # what makes that true — see `PassBroadcast.subscribe`, where doing it
        # the other way left a hole exactly one document-render wide.
        with COLLECTION_STREAM.subscribe() as updates:
            yield sse("pass", _current_pass().model_dump(mode="json"))
            # No timeout around this iteration — the broadcast does its own
            # waiting and reports silence as a falsy update. `asyncio.wait_for`
            # around `anext` delivers its cancellation *into* the generator,
            # which runs the `finally`, unsubscribes and ends the response; the
            # market stream paid roughly 150 reconnects an hour for that before
            # it was found.
            async for update in updates:
                if await request.is_disconnected():
                    return
                if not update:
                    yield KEEP_ALIVE
                    continue
                for snapshot in update.items:
                    yield sse("snapshot", _snapshot_model(snapshot).model_dump(mode="json"))
                if update.moved:
                    yield sse("pass", _current_pass().model_dump(mode="json"))

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Nginx buffers by default, which would hold a departure until the
            # buffer filled — the exact latency this endpoint exists to remove.
            "X-Accel-Buffering": "no",
        },
    )


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

    Deliberately close to `CollectResponse`, so a client that reads one press's
    answer reads this one the same way — but it counts in its own units and
    that is the one place the two deliberately part. `polling` and its
    `completed` are departures; this pass polls no departures at all. What it
    spends is **requests** and what it achieves is **windows priced**, and
    since 12.245 those are not the same number, because a far window the
    provider refuses is asked for again with a nearer end.

    That distinction is the whole reason the four figures below are four and
    not one. A pass measured live on 2026-08-21 sent three requests over twenty
    seconds to price two windows; a client told only "running" for the whole of
    it cannot tell a retry from a hang.
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
    #: How many date windows this pass means to price — the pairs it found due
    #: times the windows the horizon is cut into. `null` until the plan settles,
    #: which is a different fact from zero: zero is every pair already collected
    #: inside its cadence, and a bar drawn at zero for the other one would be
    #: claiming a denominator that does not exist yet. Same contract as
    #: `CollectResponse.polling`, in this pass's own units.
    windows: int | None
    #: Windows that have come back. The numerator for `windows`.
    windowsPriced: int
    #: Upstream requests sent so far. Above `windowsPriced` whenever a window
    #: was refused and walked back.
    requests: int
    #: Departure dates priced so far, across every window that has landed.
    dates: int
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
    windows=None,
    windowsPriced=0,
    requests=0,
    dates=0,
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
        windows=running.windows,
        windowsPriced=running.windows_priced,
        requests=running.requests,
        dates=running.dates,
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
    return _current_calendar_pass()


def _current_calendar_pass() -> CalendarCollectResponse:
    """The curve pass as it stands, for both the poll above and the stream below."""
    running = CALENDAR_RUNNER.current()
    return CALENDAR_IDLE if running is None else _calendar_pass_model(running)


@router.get("/calendar/collect/stream")
async def stream_calendar_collection(request: Request) -> StreamingResponse:
    """
    A booking-horizon pass as it unfolds, pushed.

    The board pass's twin, minus the half it has no use for. There is no
    `snapshot` event here and there is nothing missing: a board pass writes a
    file per departure and a chart draws each one as it lands, whereas a
    horizon pass writes **one** curve at the very end of the pair, so the only
    thing to fetch afterwards is the whole of `GET /calendar` — which the row
    already does when the pass stops.

    What did turn out to be missing is the middle. This endpoint used to carry
    only the two moments a pass has by definition, on the argument that a curve
    is one pair and two requests with no halfway point. Measured live on
    2026-08-21 that pass was three requests and twenty seconds, because a far
    window was refused and walked back (12.245) — so the `pass` frames now carry
    windows priced, requests spent and dates so far, and a row watching one can
    draw it rather than print an unchanging sentence for twenty seconds.

    The chart still refreshes from `GET /calendar` when the pass ends, as it
    did: a curve is a few hundred points collected once a day per pair, which is
    nothing like the unbounded `/history` payload that made pushing the board's
    snapshots worth the trouble.
    """

    async def events() -> AsyncIterator[str]:
        with CALENDAR_STREAM.subscribe() as updates:
            yield sse("pass", _current_calendar_pass().model_dump(mode="json"))
            async for update in updates:
                if await request.is_disconnected():
                    return
                if update.moved:
                    yield sse("pass", _current_calendar_pass().model_dump(mode="json"))
                else:
                    yield KEEP_ALIVE

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# ------------------------------------------------------ what the day has cost --


class SpendKindModel(BaseModel):
    """How many of the day's requests one kind of look accounts for."""

    #: `board` or `calendar`, as the ledger wrote it. Passed through rather than
    #: validated against a list: an old file holding a word this build does not
    #: know is a thing to show, not a 500.
    kind: str
    requests: int


class SpendResponse(BaseModel):
    """
    What this address has already sent today — `spend-is-read-back-not-only-written`.

    The ledger has been written since `a-day-is-what-the-budget-bounds` and read
    by nothing but the budget. That was tolerable while a pass was pressed and
    watched; it stops being tolerable the moment a scheduler runs one every
    fifteen minutes, because the first visible sign of a pass spending badly
    would then be Google declining to answer at all — from an address 12.9 says
    cannot be swapped for another.

    **What is left out.** The ledger holds one line per request with a timestamp
    and the route it went on, so a curve of the day and a table per route are
    both available. Neither is here. A per-route table is as long as the
    watchlist and is a second watchlist on a page that already has one; the file
    is where somebody actually tuning a cadence should look, and it says so in
    `RequestLedger.spend`. What survives is the facts a reader can act on — how
    much, out of what and how much is left where anything says so, and when the
    day turns over — plus the split between boards and calendars, which is the
    one breakdown that says *which half* of the collector to go and look at. Two
    of those four went optional when the ceiling did, and the shape did not
    otherwise move.
    """

    #: The day these figures are about, `YYYY-MM-DD`, in **UTC** — the ledger
    #: names its files after the UTC date, so this is not the reader's today
    #: everywhere and must not be rendered as though it were.
    day: str
    #: When the count starts again, as an instant. Derivable from `day` only by
    #: a client that knows the zone; sent rather than left to be guessed.
    resetsAt: str
    #: Requests recorded today, or `null` when the ledger cannot be read.
    #: **`null` is not zero.** A client that renders it as `0` would be drawing a
    #: quiet morning over a collector whose own record of itself is broken —
    #: and, where a `ceiling` is set, over a stopped one, because an unknown day
    #: is treated as fully spent and nothing will collect until it can be read.
    spent: int | None
    #: The day's ceiling, or `null` when there is none — **which is the
    #: default**. Never zero, and `null` must not be rendered as one: no ceiling
    #: means every due departure is polled, the opposite of a day with nothing
    #: left. `config.py` records why a count nobody had measured stopped
    #: bounding a pass, and what does bound one instead.
    ceiling: int | None
    #: What a pass starting now could still spend, or `null` when no ceiling
    #: leaves anything to be left of. Zero on an unreadable ledger under a
    #: ceiling, which is `DailyBudget`'s own answer rather than a second opinion.
    remaining: int | None
    #: The most this address has ever sent in one day, measured. **With no
    #: ceiling this is the only number on the wire a reader can judge `spent`
    #: against**, which is why it is sent unconditionally. It is a high-water
    #: mark and not a limit, and a client drawing it as one — a gauge, a
    #: percentage, a bar that fills towards it — would be reinventing precisely
    #: the unmeasured maximum that was removed.
    busiestOnRecord: int
    #: Requests by kind, largest first. Can sum to less than `spent`: the total
    #: is counted in lines and this is parsed, and a line a crash cut in half is
    #: still a request that left. Empty on a day with no file and on one that
    #: cannot be read.
    kinds: list[SpendKindModel]


@router.get("/spend", response_model=SpendResponse)
def get_spend() -> SpendResponse:
    """
    Today's request spend, for a page that is not otherwise told.

    A poll rather than a frame on `/collect/stream`, and that is the decision
    rather than the easy option. The stream carries a pass, exists only while
    one is running, and in the browser is opened by a row that pressed and
    closed when its pass ends — so the passes it could report are exactly the
    ones somebody was already watching. The passes this endpoint is for are the
    other ninety-six: unattended, on a schedule, with the page shut. A figure
    that only moved while a stream was open would be freshest precisely when it
    mattered least.

    It reads one file of one short line per request sent today and touches no
    upstream, which is what makes asking for it on a timer honest.
    """
    reading = read_spend()
    return SpendResponse(
        day=reading.day.isoformat(),
        resetsAt=reading.resets_at.isoformat(),
        spent=reading.spent,
        ceiling=reading.ceiling,
        remaining=reading.remaining,
        busiestOnRecord=BUSIEST_DAY_ON_RECORD,
        kinds=[SpendKindModel(kind=kind.kind, requests=kind.requests) for kind in reading.kinds],
    )
