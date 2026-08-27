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
from itertools import pairwise
from typing import Any

import httpx

from app.adapters.fares.models import (
    Airport,
    CalendarPrice,
    CalendarQuery,
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
_LEG_ORIGIN = 3  # IATA, where this leg takes off
_LEG_DEPARTURE_TIME = 8
_LEG_ARRIVAL_TIME = 10
_LEG_DURATION = 11  # this leg's flying time only
_LEG_DESTINATION = 6  # IATA, where this leg lands
_LEG_DEPARTURE_DATE = 20
_LEG_ARRIVAL_DATE = 21
_LEG_FLIGHT = 22  # [airline_iata, flight_number, _, airline_name]

# Positions in the itinerary itself, beside its leg list — the whole journey as
# Google states it, rather than as we would infer it from the legs.
#
# `_ITINERARY_DURATION` is the number Google prints in its own duration column:
# gate to gate, layovers included. Measured 2026-08-19 across all 68 itineraries
# in the four captured boards, it equals the legs' flying time plus the ground
# time between them, every time — which is what identifies it as the journey and
# not as some other integer that happens to sit at position 9. `_journey_minutes`
# re-checks that identity on every parse.
_ITINERARY_ORIGIN = 3
_ITINERARY_DESTINATION = 6
_ITINERARY_DURATION = 9

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


def _code(value: Any) -> str | None:
    """A three-letter IATA code, or `None` when this is not one."""
    if not isinstance(value, str):
        return None
    found = value.strip().upper()
    return found if len(found) == 3 and found.isalpha() else None


def _stop_count(flight: Any, legs: list[Any]) -> int | None:
    """
    How many times the traveller changes plane, once the legs are shown to be
    this itinerary's legs.

    `transfers` used to be `len(legs) - 1` and nothing else, which made the leg
    list the sole witness to whether a journey is direct — and a parser that
    read the *wrong* list reported "Direct" with a straight face. That is not
    hypothetical: measured 2026-08-19 against the LIM-MAD capture, truncating
    the two-leg AV 74 / AV 46 itinerary to either one of its legs produced an
    offer reading `transfers=0`, with an arrival time that looked entirely
    plausible because it was Bogota's. Flattening the two legs into one did the
    same. Nothing in the parser noticed, and nothing downstream could have.

    The check is free, because the itinerary states its own endpoints and so
    does every leg: the legs must start where the itinerary starts, finish where
    it finishes, and join end to end. A chain that does that has the leg count
    it appears to have. Decision 12.4 — a count we derived from a list we could
    not verify is not an observation, and "Direct" is the most consequential
    word on the flight table.

    Returns `None` when the codes cannot be read at all, which is a shape
    problem the caller drops the itinerary for. Raises when they read and
    contradict each other, because that is drift and the whole board has it.
    """
    origin = _code(flight[_ITINERARY_ORIGIN]) if len(flight) > _ITINERARY_ORIGIN else None
    destination = (
        _code(flight[_ITINERARY_DESTINATION]) if len(flight) > _ITINERARY_DESTINATION else None
    )
    if origin is None or destination is None:
        return None

    chain: list[tuple[str, str]] = []
    for leg in legs:
        takes_off = _code(leg[_LEG_ORIGIN]) if len(leg) > _LEG_ORIGIN else None
        lands = _code(leg[_LEG_DESTINATION]) if len(leg) > _LEG_DESTINATION else None
        if takes_off is None or lands is None:
            return None
        chain.append((takes_off, lands))

    joins = all(before[1] == after[0] for before, after in pairwise(chain))
    if chain[0][0] != origin or chain[-1][1] != destination or not joins:
        raise FareError(
            "parse-drift",
            f"Google Flights described a {origin}-{destination} itinerary whose legs read as "
            + ", ".join(f"{takes_off}-{lands}" for takes_off, lands in chain)
            + "; the legs we are counting stops from are not this itinerary's legs",
        )
    return len(legs) - 1


def _journey_minutes(flight: Any, legs: list[Any]) -> int | None:
    """
    Departure to arrival, layovers included — what a "Duration" column claims.

    This used to be the legs' flying time with the ground between them thrown
    away, which understated every connection and left the direct flights right.
    On the captured LIM-SCL board for 2027-01-21, LA 2127 changes plane at Cusco
    and read 280 minutes, "4h 40m", against a real 455: a reader comparing it
    with the 205-minute non-stop beside it was choosing on a figure nearly three
    hours out. Air time is the honest name for that number, but it is not the
    number the column is headed with and not the one anybody picks a flight on,
    so the meaning moves rather than the name.

    **Not computed from `departure_at` and `arrival_at`.** Those are local wall
    clocks at two different airports with no offset attached — see `FareOffer` —
    so their difference is the journey plus however far the destination's clock
    is from the origin's. On this very itinerary it gives 575 minutes, "9h 35m",
    overstating by exactly the two hours between Lima and Santiago in January.
    Wrong in the other direction is still wrong.

    Layover time *is* free of that problem, which is what makes the cross-check
    below worth having: a connection lands and leaves at one airport, so both
    stamps are the same clock and their difference is exact. Google's own total
    is preferred over that arithmetic because it is an observation rather than a
    derivation, and the arithmetic is kept as the thing that proves position 9
    still means what it meant when it was measured.
    """
    total = flight[_ITINERARY_DURATION] if len(flight) > _ITINERARY_DURATION else None
    if isinstance(total, bool) or not isinstance(total, int) or total <= 0:
        return None

    air = 0
    for leg in legs:
        minutes = leg[_LEG_DURATION] if len(leg) > _LEG_DURATION else None
        if isinstance(minutes, bool) or not isinstance(minutes, int):
            # Nothing to check the total against. The total is still what Google
            # said, and refusing it over a missing leg figure would throw away
            # the good half of an observation.
            return total
        air += minutes

    ground = 0
    for before, after in pairwise(legs):
        landed = _stamp(before[_LEG_ARRIVAL_DATE], before[_LEG_ARRIVAL_TIME])
        leaves = _stamp(after[_LEG_DEPARTURE_DATE], after[_LEG_DEPARTURE_TIME])
        if landed is None or leaves is None:
            return total
        ground += int(
            (datetime.fromisoformat(leaves) - datetime.fromisoformat(landed)).total_seconds() // 60
        )

    if air + ground != total:
        raise FareError(
            "parse-drift",
            f"Google Flights called this journey {total} minutes where its own legs add up "
            f"to {air} in the air and {ground} on the ground; position "
            f"{_ITINERARY_DURATION} no longer holds the journey duration",
        )
    return total


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

        transfers = _stop_count(flight, legs)
        if transfers is None:
            return None
        via_points = tuple(_code(leg[_LEG_DESTINATION]) for leg in legs[:-1])
        if any(point is None for point in via_points):
            return None

        return FareOffer(
            airline=str(airline),
            airline_name=name,
            flight_number=number,
            departure_at=departure_at,
            arrival_at=_stamp(last[_LEG_ARRIVAL_DATE], last[_LEG_ARRIVAL_TIME]),
            transfers=transfers,
            duration_minutes=_journey_minutes(flight, legs),
            price=float(price),
            currency=currency,
            via_points=via_points,
        )
    except (IndexError, KeyError, TypeError, ValueError):
        # One malformed itinerary is dropped; a payload where *every* itinerary
        # is malformed is drift, and `parse_payload` raises for that.
        #
        # `FareError` is deliberately outside this tuple. `_stop_count` and
        # `_journey_minutes` raise it when the payload is readable and
        # self-contradictory, which is not one bad row — it is the layout having
        # moved under us, and it has to leave the parser rather than be counted
        # as a dropped itinerary.
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

    if not any(offer.duration_minutes for offer in merged):
        # Decision 12.4 again, for the one field whose absence is invisible.
        # `_journey_minutes` returns `None` rather than raising when position 9
        # holds something that is not a duration, so a renumbering that leaves
        # everything else readable would empty the "Duration" column across the
        # whole board and be archived as a healthy collection. Every board ever
        # captured priced a duration on every itinerary, so none at all is the
        # layout having moved, not a board without durations.
        raise FareError(
            "parse-drift",
            f"none of the {len(merged)} itineraries on this board carried a journey "
            "duration; the payload layout has changed",
        )

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


# ------------------------------------------------------------- calendar graph --
#
# The search above answers about **one** departure date, so a month of cheapest
# fares costs thirty requests and a year costs three hundred and thirty. Google's
# own price graph does not work that way: it asks one RPC for a whole range of
# departure dates and gets one cheapest fare per day back. Measured 2026-08-19,
# one request returned 181 dates.
#
# Kept in this module rather than in a `google_flights_calendar.py` beside it.
# It is the same provider, the same User-Agent and the same rate discipline, and
# it reads its price out of the very same base64 token as an itinerary does —
# `_exact_price` applies here unchanged, which a second module could only reach
# by exporting a private or copying it.
#
# **This is not `batchexecute`.** It is a direct RPC path. An earlier attempt
# spent nine tries on `/_/FlightsFrontendUi/data/batchexecute` with rpcid
# `YMjVO` and was answered HTTP 500 every time: right service, wrong transport.
# The response envelope is batchexecute's, which is what made that plausible.
#
# **No session is needed.** Measured 2026-08-19 from this module's own client
# with no cookies at all: HTTP 200 with a full 181-day answer. The capture this
# was built from came from a signed-in browser, and that turned out not to
# matter.

CALENDAR_URL = (
    "https://www.google.com/_/FlightsFrontendUi/data/"
    "travel.frontend.flights.FlightsFrontendService/GetCalendarGraph"
)

# How many departure dates one request may ask for. Measured 2026-08-19 against
# the live endpoint, LIM-CUZ: 21 dates answered, 181 dates answered, 331 dates
# (the whole booking horizon) was refused with gRPC status 3, INVALID_ARGUMENT,
# and an empty `ErrorResponse`. A 149-date window ending 330 days out answered
# in full, which is what says the refusal was about the *width* of the range and
# not about how far ahead its far end sits. So the true cap is somewhere in
# 182..330 and was deliberately not bisected: knowing it exactly would not
# change the design, because two windows already cover the horizon and one
# cannot.
CALENDAR_RANGE_DAYS = 181

# A form POST, so the content type is stated rather than left to the client. The
# rest is the search's headers, because it is the same address talking to the
# same host and looking like two different clients would be worse than looking
# like one.
CALENDAR_HEADERS = {
    **HEADERS,
    "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
}

# The `)]}'` anti-JSON-hijacking guard Google puts in front of every RPC answer.
_GUARD = ")]}'"

# Positions inside one row of the graph: `["2026-12-09", null, [[null, 60],
# "<token>"], 1]`. Same untagged-array hazard as the search payload, and the
# same remedy — named here so drift is a one-line edit, pinned in the tests
# against a captured response.
_GRAPH_ROWS = 1  # data[1]; data[0] is a session block we have no use for
_ROW_DATE = 0
_ROW_PRICE = 2  # [[null, rounded], "<base64 protobuf>"] — an itinerary's shape

_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")


def build_calendar_request(query: CalendarQuery) -> str:
    """
    The `f.req` form field: plain JSON, no protobuf anywhere.

    Every number below is a position in an untagged array, so each one is named
    rather than left as a literal in a nested list. The shape was captured from
    a live page on 2026-08-19 and reproduced byte for byte before anything was
    built on it.
    """
    leg = [
        [[[query.origin.strip().upper(), 0]]],  # 0: origin
        [[[query.destination.strip().upper(), 0]]],  # 1: destination
        None,
        0,
        None,
        None,
        query.start,  # 6: the anchor departure, which we set to the range start
        *([None] * 7),
        3,
    ]
    search = [
        None,
        None,
        _TRIP_ONE_WAY,  # 2: same trip-type enum the `?tfs=` writer uses
        None,
        [],
        _SEAT_ECONOMY,  # 5
        [_PASSENGER_ADULT, 0, 0, 0],  # 6: adults, children, infants in seat/lap
        *([None] * 6),
        [leg],  # 13
        None,
        None,
        None,
        1,
    ]
    # `[from, to]` is the whole reason this endpoint is worth having: it is the
    # window of departure dates to price, and it is what turns thirty requests
    # for a month into one.
    inner = [None, search, [query.start, query.end]]
    return json.dumps([None, json.dumps(inner, separators=(",", ":"))], separators=(",", ":"))


def _rpc_frames(text: str) -> list[Any]:
    """
    The frames of one RPC answer, out from behind the guard.

    Measured on three live responses on 2026-08-19: the body is `)]}'`, a blank
    line, and then one JSON array — `[["wrb.fr", ...], ["di", n],
    ["af.httprm", ...]]` — with no length prefix anywhere. The note this was
    built from described a length line, which is the shape `batchexecute`
    streams answers in, so both are read here rather than one being guessed at.
    Six lines is a cheap price for not losing the whole feature to a transport
    detail that was observed once and never since.
    """
    if not text.startswith(_GUARD):
        raise FareError(
            "unreadable",
            "Google Flights answered the calendar RPC without its )]}' guard "
            "(a challenge, a consent page, or a changed transport)",
        )
    body = text[len(_GUARD) :].strip()

    frames: list[Any] = []
    position = 0
    while position < len(body):
        newline = body.find("\n", position)
        header = body[position:newline] if newline != -1 else ""
        if newline != -1 and header.strip().isdigit():
            size = int(header.strip())
            chunk = body[newline + 1 : newline + 1 + size]
            position = newline + 1 + size
        else:
            chunk = body[position:]
            position = len(body)
        try:
            found = json.loads(chunk)
        except ValueError:
            continue
        if isinstance(found, list):
            frames.extend(found)

    if not frames:
        raise FareError("unreadable", "Google Flights calendar answer carried no readable frames")
    return frames


def _graph_data(frames: list[Any]) -> Any:
    """
    The one frame that carries the graph, or the reason there is not one.

    A refused request comes back with the same envelope and the same `wrb.fr`
    frame, only with `null` where the payload goes and a gRPC status in its
    place — `[3]` for INVALID_ARGUMENT, which is what asking for too wide a
    range earns. That is upstream saying no, and it must not read as drift.
    """
    for frame in frames:
        if not isinstance(frame, list) or not frame or frame[0] != "wrb.fr":
            continue
        payload = frame[2] if len(frame) > 2 else None
        if isinstance(payload, str) and payload:
            try:
                return json.loads(payload)
            except ValueError as exc:
                raise FareError(
                    "unreadable", f"Google Flights calendar payload was not JSON: {exc}"
                ) from exc
        status = frame[5] if len(frame) > 5 else None
        code = status[0] if isinstance(status, list) and status else None
        # Status 3 gets its own code. Every refusal used to arrive as
        # `upstream-error`, so a caller that wanted to react to *this* one — the
        # only refusal it can do anything about, by asking for less — had to
        # match on the message text. Measured 2026-08-20: a window ending +330
        # days out is refused where the same window ending +329 answers in full,
        # and the day before that +330 answered, so the far edge is a date the
        # provider will price up to rather than a distance from today. Naming
        # the code is what lets the collector narrow and retry without reading
        # English.
        if code == 3:
            raise FareError(
                "range-refused",
                "Google Flights refused the calendar request with status 3: "
                "the range reaches further ahead than it will price",
            )
        raise FareError(
            "upstream-error",
            f"Google Flights refused the calendar request with status {code!r}",
        )
    raise FareError("unreadable", "Google Flights calendar answer had no wrb.fr frame")


def parse_calendar(data: Any) -> list[CalendarPrice]:
    """
    One cheapest fare per departure date, in the order Google sent them.

    Decision 12.4, and this endpoint needs it more than the search does: it is
    undocumented, its request is a positional array, and its natural failure is
    an empty list that would read as "no flights in the next eleven months"
    rather than as "we stopped understanding the answer". So **zero dates is
    never an answer here**. A date the provider priced at nothing is kept with a
    `None` price, because a day with no flights and a day we never asked about
    are different facts and only one of them is our gap.
    """
    rows = data[_GRAPH_ROWS] if isinstance(data, list) and len(data) > _GRAPH_ROWS else None
    if not isinstance(rows, list) or not rows:
        raise FareError(
            "parse-drift",
            "Google Flights calendar answered with no dates where the whole "
            "range was expected; the payload layout has changed",
        )

    found: list[CalendarPrice] = []
    for row in rows:
        if not isinstance(row, list) or len(row) <= _ROW_PRICE:
            continue
        departure = row[_ROW_DATE]
        if not isinstance(departure, str) or not _DATE.fullmatch(departure):
            continue
        node = row[_ROW_PRICE]
        price: float | None = None
        if isinstance(node, list) and node:
            exact = _exact_price(node[1] if len(node) > 1 else None)
            rounded = node[0][1] if isinstance(node[0], list) and len(node[0]) > 1 else None
            if exact is not None:
                price = exact
            elif isinstance(rounded, (int, float)) and not isinstance(rounded, bool):
                price = float(rounded)
        found.append(CalendarPrice(departure_date=departure, price=price))

    if not found:
        raise FareError(
            "parse-drift",
            f"Google Flights calendar returned {len(rows)} rows and none of them "
            "carried a departure date; the payload layout has changed",
        )
    if all(point.price is None for point in found):
        # Not drift: every row was shaped the way we expect and simply had
        # nothing to sell. A city pair with no service answers exactly this.
        raise FareError(
            "no-offers",
            f"Google Flights has no fares on any of the {len(found)} dates asked about",
        )
    return found


async def fetch_calendar(client: httpx.AsyncClient, query: CalendarQuery) -> list[CalendarPrice]:
    """
    One request, one cheapest fare per departure date in the window.

    This carries one number a day and nothing else — no carrier, no times, no
    itineraries — so it does not replace the search for a month somebody is
    actually reading. It is what makes the other eleven months visible at all.
    """
    try:
        response = await client.post(
            CALENDAR_URL,
            # Upper-case because that is the request that was validated live;
            # `fetch_search` sends the lower-case form its own capture used.
            params={"hl": "en", "gl": "us", "curr": query.currency.strip().upper()},
            headers=CALENDAR_HEADERS,
            data={"f.req": build_calendar_request(query)},
            follow_redirects=True,
        )
    except httpx.HTTPError as exc:
        raise FareError("unreachable", f"Google Flights could not be reached: {exc}") from exc

    if response.status_code == 429:
        raise FareError("rate-limited", "Google Flights is rate limiting this address")
    if response.status_code >= 400:
        raise FareError("upstream-error", f"Google Flights answered {response.status_code}")
    if "consent.google.com" in str(response.url):
        raise FareError("blocked", "Google Flights redirected to consent; this address is flagged")

    return parse_calendar(_graph_data(_rpc_frames(response.text)))
