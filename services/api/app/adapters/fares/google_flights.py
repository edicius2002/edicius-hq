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
from typing import Any

import httpx

from app.adapters.fares.models import FareError, FareOffer, FareQuery
from app.adapters.wire import (
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

# Positions inside one itinerary's leg array. Named so a drift fix is a one-line
# edit here rather than a hunt through the parser.
_LEG_DEPARTURE_TIME = 8
_LEG_ARRIVAL_TIME = 10
_LEG_DURATION = 11
_LEG_DEPARTURE_DATE = 20
_LEG_ARRIVAL_DATE = 21
_LEG_FLIGHT = 22  # [airline_iata, flight_number, _, airline_name]


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


def _offer(itinerary: Any, currency: str) -> FareOffer | None:
    """One itinerary, or `None` when it does not have the shape we depend on."""
    try:
        flight = itinerary[0]
        price = itinerary[1][0][1]
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


def parse_payload(payload: Any, currency: str) -> list[FareOffer]:
    try:
        rows = payload[3][0]
    except (IndexError, KeyError, TypeError) as exc:
        raise FareError(
            "parse-drift",
            "Google Flights payload no longer has itineraries where we look for them",
        ) from exc

    if rows is None:
        # Google's own way of saying it found nothing. Distinct from drift, and
        # a real answer for an unserved route on an unserved day.
        raise FareError("no-offers", "Google Flights found no itineraries for this search")

    offers = [offer for offer in (_offer(row, currency) for row in rows) if offer is not None]
    if rows and not offers:
        raise FareError(
            "parse-drift",
            f"Google Flights returned {len(rows)} itineraries and none could be read; "
            "the payload layout has changed",
        )
    return sorted(offers, key=lambda offer: offer.price)


async def fetch_offers(client: httpx.AsyncClient, query: FareQuery) -> list[FareOffer]:
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

    return parse_payload(extract_payload(response.text), query.currency.upper())
