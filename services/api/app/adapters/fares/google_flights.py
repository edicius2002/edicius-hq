"""
Google Flights, for live itineraries with airline and departure time.

Unofficial and undocumented, like `app.adapters.yahoo` — but more so. There is
no JSON endpoint: the whole search goes up as a base64 protobuf in `?tfs=`, and
the answer comes back inside a `<script class="ds:1">` block that the page
would otherwise hand to its own JavaScript. We read that block and never run
the JavaScript.

Two things about this module are deliberate and worth not undoing:

**No browser and no TLS impersonation.** Measured on 2026-08-17 from a
residential address: plain httpx with a browser User-Agent answered 200 on four
LIM routes with no consent page and no challenge. Reference implementations
reach for a fingerprint-spoofing client; ours does not need one, and adding a
native dependency to solve a problem we do not have would be paid for on every
install. If this starts failing, that is the first thing to revisit.

**Positional indices, guarded loudly.** The payload is an untagged array, so
every field below is a position, and a Google refactor renumbers them without
telling anyone. The failure mode is silent — zero offers, not an exception —
which is exactly the shape of bug that goes unnoticed for a month. So drift is
converted into a typed error here, and `tests/test_fares_google_flights.py`
pins the positions against a captured fixture.

Rate discipline: one request per route per day, seconds apart. This endpoint is
not metered for us, which makes it our job to stay quiet rather than Google's
job to throttle us.
"""

import base64
import json
import re
from datetime import UTC, datetime
from typing import Any

import httpx

from app.adapters.fares.models import (
    Airport,
    FareError,
    FareInsights,
    FareOffer,
    FareQuery,
    PricePoint,
    SearchResult,
)
from app.adapters.wire import (
    WireError,
    read_message,
    write_length_delimited,
    write_packed_varints,
    write_string,
    write_varint_field,
)

PROVIDER = "google-flights"

URL = "https://www.google.com/travel/flights"

# A default httpx client identifies itself as Python and is answered with a
# consent interstitial. Same reasoning as the Yahoo adapter's header.
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

_SEAT_ECONOMY = 1
_TRIP_ROUND = 1
_TRIP_ONE_WAY = 2
_PASSENGER_ADULT = 1

_SCRIPT = re.compile(r'<script class="ds:1"[^>]*>(.*?)</script>', re.DOTALL)

# The board arrives in two lists, and both of them are the board. `payload[2]`
# is what the page prints under "Best departing flights"; `payload[3]` is
# everything under "Other departing flights". Measured 2026-08-19 against two
# captured responses: LIM-CUZ 2026-09-09 held 5 and 31 with no itinerary in
# common, and LIM-MAD 2026-10-15 held 5 and 4, so reading only `payload[3]`
# archived four of that board's nine itineraries. Both are read here.
#
# `payload[3]` is the required one. It is the whole board minus a handful, so
# its disappearance is drift and is raised as such even when `payload[2]` still
# has itineraries — see `parse_payload`.
_BEST_BLOCK = 2
_ALL_BLOCK = 3

# Positions inside one itinerary's leg array. Named so a drift fix is a one-line
# edit here rather than a hunt through the parser.
_LEG_DEPARTURE_TIME = 8
_LEG_ARRIVAL_TIME = 10
_LEG_DURATION = 11
_LEG_DEPARTURE_DATE = 20
_LEG_ARRIVAL_DATE = 21
_LEG_FLIGHT = 22  # [airline_iata, flight_number, _, airline_name]

# `itinerary[1]` is `[[null, rounded_price], "<base64 protobuf>"]`. The integer
# is what the page prints; the token carries the same price to the cent, which
# is the one worth archiving — measured 2026-08-18, two LIM-CUZ offers that both
# displayed 64 were 63.34 and 63.36, so the rounding merges distinct fares.
_PRICE_TOKEN_DETAIL = 3  # nested message: {1: units, 2: decimals, 3: currency}
_PRICE_UNITS = 1
_PRICE_DECIMALS = 2

# The insight block. `payload[5][10][0]` is 61 `[epoch_ms, price]` pairs spaced
# exactly 24h and ending today, scoped to this search rather than the route.
_INSIGHT_BLOCK = 5
_INSIGHT_TYPICAL = 2
_INSIGHT_USUAL_LOW = 4
_INSIGHT_USUAL_HIGH = 5
_INSIGHT_HISTORY = 10

# `payload[1][0]` lists the airports the query named, each as
# `[[code, _], name, [_, city, images], [lat, lng], countryCode, _, country]`.
_AIRPORT_BLOCK = 1
_AIRPORT_NAME = 1
_AIRPORT_PLACE = 2
_AIRPORT_POINT = 3
_AIRPORT_COUNTRY = 6


def _airport(code: str) -> bytes:
    return write_string(2, code.strip().upper())


def _flight_data(date: str, origin: str, destination: str) -> bytes:
    # Field-number order, because that is what a real protobuf writer emits and
    # matching it keeps the bytes comparable against a reference implementation.
    return (
        write_string(2, date)
        + write_length_delimited(13, _airport(origin))
        + write_length_delimited(14, _airport(destination))
    )


def build_tfs(query: FareQuery) -> str:
    """The `?tfs=` parameter: one `Info` message, base64-encoded."""
    legs = [_flight_data(query.flight_date, query.origin, query.destination)]
    if query.return_date:
        legs.append(_flight_data(query.return_date, query.destination, query.origin))

    info = b"".join(
        [
            *(write_length_delimited(3, leg) for leg in legs),
            write_packed_varints(8, [_PASSENGER_ADULT]),
            write_varint_field(9, _SEAT_ECONOMY),
            write_varint_field(19, _TRIP_ROUND if query.return_date else _TRIP_ONE_WAY),
        ]
    )
    return base64.b64encode(info).decode("ascii")


def extract_payload(html: str) -> Any:
    """
    Pull the `ds:1` data island out of the page.

    Separate from parsing so a test can exercise each half: this one fails when
    Google changes the page, the other when Google changes the payload.
    """
    match = _SCRIPT.search(html)
    if match is None:
        raise FareError(
            "unreadable",
            "Google Flights returned a page with no ds:1 data block "
            "(a consent interstitial, a challenge, or a changed page shape)",
        )

    body = match.group(1)
    try:
        raw = body.split("data:", 1)[1].rsplit(",", 1)[0]
    except IndexError as exc:
        raise FareError("unreadable", "ds:1 block carried no data section") from exc

    if raw.rstrip().endswith("errorHasStatus: true"):
        raise FareError("upstream-error", "Google Flights reported an error for this search")

    try:
        return json.loads(raw)
    except ValueError as exc:
        raise FareError("unreadable", f"ds:1 data section was not JSON: {exc}") from exc


def _clock(value: Any) -> tuple[int, int]:
    """
    `[5, 50]` is 05:50, `[11]` is 11:00, `[None, 15]` is 00:15.

    Google omits zeroes rather than sending them, so a missing element and a
    `None` both mean nought. Reading `[None, 15]` as anything but 00:15 puts a
    red-eye departure in the middle of the afternoon.
    """
    if not isinstance(value, list):
        return 0, 0
    hour = value[0] if len(value) > 0 and isinstance(value[0], int) else 0
    minute = value[1] if len(value) > 1 and isinstance(value[1], int) else 0
    return hour, minute


def _stamp(date: Any, time: Any) -> str | None:
    """Local wall clock at the airport, ISO 8601, no zone — see `FareOffer`."""
    if not isinstance(date, list) or len(date) < 3:
        return None
    year, month, day = date[0], date[1], date[2]
    if not all(isinstance(part, int) for part in (year, month, day)):
        return None
    hour, minute = _clock(time)
    return f"{year:04d}-{month:02d}-{day:02d}T{hour:02d}:{minute:02d}"


def _exact_price(node: Any) -> float | None:
    """
    The price to the cent, out of the token beside the rounded one.

    Returns `None` rather than raising: the rounded integer is always there, so
    a token we cannot read costs precision and not the observation. Both
    standard and URL-safe base64 decode this to the same bytes (checked across
    three routes), and padding is restored because Google strips it.
    """
    if not isinstance(node, str) or not node:
        return None
    try:
        raw = base64.urlsafe_b64decode(node + "=" * (-len(node) % 4))
        detail = read_message(raw).get(_PRICE_TOKEN_DETAIL)
        if not isinstance(detail, bytes):
            return None
        inner = read_message(detail)
        units, decimals = inner.get(_PRICE_UNITS), inner.get(_PRICE_DECIMALS)
        if not isinstance(units, int) or not isinstance(decimals, int):
            return None
        if decimals < 0 or decimals > 6:
            return None
        return units / (10**decimals)
    except (ValueError, WireError):
        return None


def _offer(itinerary: Any, currency: str) -> FareOffer | None:
    """One itinerary, or `None` when it does not have the shape we depend on."""
    try:
        flight = itinerary[0]
        price = _exact_price(itinerary[1][1]) or itinerary[1][0][1]
        legs = flight[2]
        first, last = legs[0], legs[-1]

        departure_at = _stamp(first[_LEG_DEPARTURE_DATE], first[_LEG_DEPARTURE_TIME])
        if departure_at is None or not isinstance(price, (int, float)):
            return None

        marker = first[_LEG_FLIGHT] if isinstance(first[_LEG_FLIGHT], list) else []
        airline = marker[0] if len(marker) > 0 and isinstance(marker[0], str) else flight[0]
        number = marker[1] if len(marker) > 1 and isinstance(marker[1], str) else None
        name = marker[3] if len(marker) > 3 and isinstance(marker[3], str) else None
        if name is None:
            names = flight[1] if isinstance(flight[1], list) else []
            name = names[0] if names and isinstance(names[0], str) else None

        durations = [leg[_LEG_DURATION] for leg in legs]
        total = sum(d for d in durations if isinstance(d, int)) or None

        return FareOffer(
            airline=str(airline),
            airline_name=name,
            flight_number=number,
            departure_at=departure_at,
            arrival_at=_stamp(last[_LEG_ARRIVAL_DATE], last[_LEG_ARRIVAL_TIME]),
            transfers=len(legs) - 1,
            duration_minutes=total,
            price=float(price),
            currency=currency,
        )
    except (IndexError, KeyError, TypeError, ValueError):
        # One malformed itinerary is dropped; a payload where *every* itinerary
        # is malformed is drift, and `parse_payload` raises for that.
        return None


def parse_airports(payload: Any) -> list[Airport]:
    """
    Where the queried airports are, or an empty list.

    Never raises. A search that answers with itineraries but no airport block
    is still a good observation — the coordinates are a bonus this feature did
    not have at all until it noticed they were already arriving.
    """
    try:
        rows = payload[_AIRPORT_BLOCK][0]
    except (IndexError, KeyError, TypeError):
        return []
    if not isinstance(rows, list):
        return []

    found: list[Airport] = []
    for row in rows:
        try:
            node = row[0]
            code = node[0][0]
            point = node[_AIRPORT_POINT]
            latitude, longitude = point[0], point[1]
        except (IndexError, KeyError, TypeError):
            continue
        if not isinstance(code, str) or len(code.strip()) != 3:
            continue
        if isinstance(latitude, bool) or not isinstance(latitude, (int, float)):
            continue
        if isinstance(longitude, bool) or not isinstance(longitude, (int, float)):
            continue
        if not (-90 <= latitude <= 90) or not (-180 <= longitude <= 180):
            continue

        def text(value: Any) -> str | None:
            return value.strip() or None if isinstance(value, str) else None

        place = node[_AIRPORT_PLACE] if len(node) > _AIRPORT_PLACE else None
        found.append(
            Airport(
                code=code.strip().upper(),
                name=text(node[_AIRPORT_NAME]) if len(node) > _AIRPORT_NAME else None,
                city=text(place[1]) if isinstance(place, list) and len(place) > 1 else None,
                country=text(node[_AIRPORT_COUNTRY]) if len(node) > _AIRPORT_COUNTRY else None,
                latitude=float(latitude),
                longitude=float(longitude),
            )
        )
    return found


def parse_history(payload: Any) -> list[PricePoint]:
    """
    The daily series Google ships with the search, or an empty list.

    Absent is normal, not broken: it thins out past roughly 280 days ahead and
    is gone by 330, so this never raises. The stamps are local midnight at the
    origin, and the date is taken from the stamp as-is rather than converted —
    a conversion would shift every point by the reader's own distance from Lima.
    """
    try:
        rows = payload[_INSIGHT_BLOCK][_INSIGHT_HISTORY][0]
    except (IndexError, KeyError, TypeError):
        return []
    if not isinstance(rows, list):
        return []

    points: list[PricePoint] = []
    for row in rows:
        try:
            stamp, price = row[0], row[1]
        except (IndexError, KeyError, TypeError):
            continue
        if isinstance(stamp, bool) or not isinstance(stamp, (int, float)):
            continue
        if isinstance(price, bool) or not isinstance(price, (int, float)) or price <= 0:
            continue
        moment = datetime.fromtimestamp(stamp / 1000, UTC)
        points.append(PricePoint(date=moment.date().isoformat(), price=float(price)))
    return points


def parse_insights(payload: Any) -> FareInsights | None:
    """What this search usually costs, when the payload says."""

    def value(index: int) -> float | None:
        try:
            node = payload[_INSIGHT_BLOCK][index]
        except (IndexError, KeyError, TypeError):
            return None
        if not isinstance(node, list) or len(node) < 2:
            return None
        found = node[1]
        if isinstance(found, bool) or not isinstance(found, (int, float)):
            return None
        return float(found)

    insights = FareInsights(
        typical=value(_INSIGHT_TYPICAL),
        usual_low=value(_INSIGHT_USUAL_LOW),
        usual_high=value(_INSIGHT_USUAL_HIGH),
    )
    if insights.typical is None and insights.usual_low is None and insights.usual_high is None:
        return None
    return insights


#: A block that is not in the payload at all, as distinct from one Google
#: filled with `null` to say it found nothing. The two mean opposite things and
#: `None` cannot carry both.
_ABSENT = object()


def _itinerary_rows(payload: Any, index: int) -> Any:
    """The rows of one itinerary block, `None` for empty, `_ABSENT` for missing."""
    try:
        rows = payload[index][0]
    except (IndexError, KeyError, TypeError):
        return _ABSENT
    if rows is None:
        return None
    return rows if isinstance(rows, list) else _ABSENT


def _read_rows(rows: Any, currency: str) -> list[FareOffer]:
    if not isinstance(rows, list):
        return []
    return [offer for offer in (_offer(row, currency) for row in rows) if offer is not None]


def _order(offer: FareOffer) -> tuple[float, str, str, str, str]:
    """
    A total order over a board, so two identical boards read identically.

    Cheapest first is what the page wants, but price alone is not a total order
    — thirteen LIM-CUZ itineraries shared 62.16 in one capture — and leaving
    those thirteen in whatever order the two blocks happened to arrive in would
    let the archive's change detection fire on Google reshuffling its own list.
    The remaining fields are tiebreakers, not preferences.
    """
    return (
        offer.price,
        offer.departure_at,
        offer.airline,
        offer.flight_number or "",
        offer.arrival_at or "",
    )


def parse_payload(payload: Any, currency: str) -> list[FareOffer]:
    """
    Every itinerary on the board, cheapest first, each of them once.

    Both blocks are read and merged. Duplicates are dropped on the whole offer
    rather than on `(airline, flight_number, departure_at)`, which is what
    `fare_history.fingerprint` and the web's `flightKey` treat as a flight's
    identity: those name the *first leg*, and the LIM-MAD capture has two
    genuinely different itineraries behind one such key — AV 50 to Bogota
    continuing on AV 182 at 16:25 for 626.69, and the same AV 50 continuing on
    AV 10 at 21:35 for 602.54. Deduplicating on the first leg would have thrown
    one of those away, which is the same loss this fix exists to stop. The
    whole offer is the safe key: two rows that agree on every field we record
    are indistinguishable to everything downstream anyway, so collapsing them
    loses nothing, while two rows that differ anywhere are kept.
    """
    rest = _itinerary_rows(payload, _ALL_BLOCK)
    if rest is _ABSENT:
        # Raised even when the best-departing block is full of itineraries. The
        # alternative — returning those five — would archive a board missing
        # the 86% that `payload[3]` carried on the measured LIM-CUZ search,
        # with a heartbeat line saying the collection went fine. Decision 12.4:
        # drift is a typed error, never a quiet partial answer.
        raise FareError(
            "parse-drift",
            "Google Flights payload no longer has itineraries where we look for them",
        )

    best = _itinerary_rows(payload, _BEST_BLOCK)
    if best is _ABSENT:
        # Not drift. The captured LIM-SCL response has a literal `null` at
        # `payload[2]`, so a board with no best-departing section is a shape
        # Google really sends and not a renumbering.
        best = None

    if not best and not rest:
        # Google's own way of saying it found nothing — either block empty or
        # `null`. Distinct from drift, and a real answer for an unserved route
        # on an unserved day.
        raise FareError("no-offers", "Google Flights found no itineraries for this search")

    best_offers = _read_rows(best, currency)
    rest_offers = _read_rows(rest, currency)
    if rest and not rest_offers:
        raise FareError(
            "parse-drift",
            f"Google Flights returned {len(rest)} itineraries and none could be read; "
            "the payload layout has changed",
        )
    if not best_offers and not rest_offers:
        raise FareError(
            "parse-drift",
            f"Google Flights returned {len(best)} best-departing itineraries and none "
            "could be read; the payload layout has changed",
        )

    seen: set[FareOffer] = set()
    merged: list[FareOffer] = []
    for offer in (*best_offers, *rest_offers):
        if offer in seen:
            continue
        seen.add(offer)
        merged.append(offer)
    return sorted(merged, key=_order)


async def fetch_search(client: httpx.AsyncClient, query: FareQuery) -> SearchResult:
    """
    One request, everything it answered with.

    The itinerary list, the 60-day daily history and the insight block all
    arrive in the same response. Fetching them separately would spend a second
    request on data already downloaded, and requests are the scarce resource
    here — the endpoint is unmetered, so the only budget is how much traffic
    this address can send before Google stops answering it.
    """
    params = {
        "tfs": build_tfs(query),
        "hl": "en",
        "curr": query.currency.lower(),
    }
    try:
        response = await client.get(URL, params=params, headers=HEADERS, follow_redirects=True)
    except httpx.HTTPError as exc:
        raise FareError("unreachable", f"Google Flights could not be reached: {exc}") from exc

    if response.status_code == 429:
        raise FareError("rate-limited", "Google Flights is rate limiting this address")
    if response.status_code >= 400:
        raise FareError("upstream-error", f"Google Flights answered {response.status_code}")
    if "consent.google.com" in str(response.url):
        raise FareError("blocked", "Google Flights redirected to consent; this address is flagged")

    payload = extract_payload(response.text)
    return SearchResult(
        offers=parse_payload(payload, query.currency.upper()),
        history=parse_history(payload),
        insights=parse_insights(payload),
        airports=parse_airports(payload),
    )


async def fetch_offers(client: httpx.AsyncClient, query: FareQuery) -> list[FareOffer]:
    """Just the itineraries, for callers that want a live look and nothing else."""
    return (await fetch_search(client, query)).offers
