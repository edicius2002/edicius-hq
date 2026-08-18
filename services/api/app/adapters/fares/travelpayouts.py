"""
Travelpayouts, for continuity when the scraper stops working.

Documented, tokened and stable — everything `google_flights` is not. It is here
because the primary provider reads an undocumented array by position and will
one day stop being able to, and a gap in this archive is permanent: nobody can
re-answer what a route cost last Tuesday.

**It is not the workhorse, and the measurement is why.** Phase 0 of the plan
made this call empirically on 2026-08-18, from the token in `.env`:

- *Coverage.* 4 of 5 Lima routes answered. `LIM-CUZ`, `LIM-SCL` and `LIM-MAD`
  returned data; `LIM-BOG` returned nothing on either endpoint.
- *Granularity.* `prices_for_dates` returns **one offer per departure date**,
  the cheapest — asked for a whole month with `limit=100` it gave 29 rows
  across 29 dates, never two on one date. It cannot answer "by airline and
  departure time", which is the granularity this feature was built for.
- *Freshness.* The prices are a cache of other people's searches. `found_at`
  on `/v2/prices/latest` read 4 to 6 days old, and the v3 endpoint that carries
  the airline does not report age at all. A price from here is not a price now.
- *Long haul thins out.* `LIM-MAD` answered for a month and returned nothing
  for a single named date.

So this provider answers a narrower question than the scraper does, and every
snapshot it produces is stamped with its name so a reader can tell which kind
of observation they are looking at. Silently mixing a days-old cheapest-of-the-
day into a series of live itineraries would be the quiet corruption this
feature has spent its whole design avoiding.

Zones: the API returns `departure_at` with the origin's UTC offset. We drop the
offset and keep the wall clock, because `google_flights` reports wall clock and
no offset, and decision 12.7 says the contract is what the departure board
says. Two providers must not disagree about what a time means.
"""

import logging
from typing import Any

import httpx

from app.adapters.fares.models import FareError, FareOffer, FareQuery, transport_reason
from app.config import travelpayouts_marker, travelpayouts_token

logger = logging.getLogger(__name__)

PROVIDER = "travelpayouts"

URL = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates"

# The v1 endpoints answer with round-trip prices even when no return date is
# asked for, which would put a return fare in a one-way series and look like a
# price jump. v3 takes `one_way` and honours it: measured 42 USD one way where
# `/v1/prices/cheap` said 80 for the same route and month.
_SORT_BY_PRICE = "price"

# One request already returns every offer the cache has for the date, so this
# is a ceiling on a payload rather than a page size we intend to fill.
_LIMIT = 100


def _authenticated_params(query: FareQuery, token: str) -> dict[str, str]:
    params = {
        "origin": query.origin,
        "destination": query.destination,
        "departure_at": query.flight_date,
        "currency": query.currency.lower(),
        "sorting": _SORT_BY_PRICE,
        "limit": str(_LIMIT),
        "token": token,
    }
    if query.return_date:
        params["return_at"] = query.return_date
    else:
        params["one_way"] = "true"
    marker = travelpayouts_marker()
    if marker:
        # Filters the cache to searches made under our own marker. Without it
        # the numbers come from everybody's searches, which is a different
        # population from one day to the next — and a series whose population
        # changes underneath it is not a series.
        params["marker"] = marker
        params["show_to_affiliates"] = "true"
    return params


def _wall_clock(value: Any) -> str | None:
    """
    `2026-10-17T19:55:00-05:00` -> `2026-10-17T19:55:00`.

    The offset is the origin airport's, so dropping it leaves exactly the time
    on the departure board — which is the contract. Converting to UTC instead
    would move a 00:15 Lima departure to the previous day for anyone who later
    formatted it, and the archive keys observations by departure date.
    """
    if not isinstance(value, str) or "T" not in value:
        return None
    stamp = value.strip()
    date, _, clock = stamp.partition("T")
    if len(date) != 10:
        return None
    # Trim the zone designator, whichever spelling arrived.
    for marker in ("+", "-", "Z"):
        index = clock.find(marker)
        if index > 0:
            clock = clock[:index]
            break
    clock = clock.strip()
    if len(clock) < 5:
        return None
    # `19:55:00` and `19:55` are the same departure, and `google_flights` writes
    # the second spelling. ADR 0002 asks the archive not to carry two spellings
    # of one thing for a human reading it years from now, so the seconds go when
    # they say nothing — and stay when they would be a lie to drop.
    if len(clock) >= 8 and clock[5:8] == ":00":
        clock = clock[:5]
    return f"{date}T{clock}"


def _minutes(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int | float):
        return None
    minutes = int(value)
    return minutes if minutes > 0 else None


def _offer(row: Any, currency: str) -> FareOffer | None:
    """
    One row, or `None` when it cannot be read.

    Repair what is repairable, drop what is not, invent nothing. A row without
    a price, an airline or a departure time is not a cheap flight, it is a row
    we did not understand.
    """
    if not isinstance(row, dict):
        return None
    airline = row.get("airline")
    price = row.get("price")
    departure_at = _wall_clock(row.get("departure_at"))
    if not isinstance(airline, str) or not airline.strip() or not departure_at:
        return None
    if isinstance(price, bool) or not isinstance(price, int | float) or price <= 0:
        return None

    flight_number = row.get("flight_number")
    transfers = row.get("transfers")
    return FareOffer(
        airline=airline.strip().upper(),
        # The API sends a code and no carrier name. `None` says so; filling it
        # with the code would make the page render "JA" as if it were a name.
        airline_name=None,
        flight_number=str(flight_number).strip() or None if flight_number is not None else None,
        departure_at=departure_at,
        # Arrival is not reported. It could be derived from `duration_to`, but
        # the origin and destination are in different zones often enough that
        # the result would be a plausible wrong time rather than a missing one.
        arrival_at=None,
        transfers=int(transfers)
        if isinstance(transfers, int) and not isinstance(transfers, bool)
        else 0,
        duration_minutes=_minutes(row.get("duration_to")) or _minutes(row.get("duration")),
        price=float(price),
        currency=currency.upper(),
    )


def parse_payload(payload: Any, currency: str) -> list[FareOffer]:
    """
    Offers from a decoded response body.

    Separate from the request so a captured body can be replayed in a test, the
    same split `google_flights.parse_payload` uses.
    """
    if not isinstance(payload, dict):
        raise FareError("unreadable", "Travelpayouts answered with something that is not an object")
    if payload.get("success") is False:
        raise FareError("upstream-error", f"Travelpayouts refused: {payload.get('error')}")

    rows = payload.get("data")
    if not isinstance(rows, list):
        raise FareError("unreadable", "Travelpayouts response carried no data list")
    if not rows:
        raise FareError("no-offers", "Travelpayouts has no cached price for this route and date")

    offers = [offer for offer in (_offer(row, currency) for row in rows) if offer is not None]
    if not offers:
        # Rows arrived and none could be read. Unlike the scraper this is a
        # documented JSON API, so this means the documented shape changed —
        # rarer, and worth the same loud code rather than an empty list.
        raise FareError(
            "parse-drift",
            f"Travelpayouts returned {len(rows)} row(s) and none could be read",
        )
    offers.sort(key=lambda offer: offer.price)
    return offers


async def fetch_offers(client: httpx.AsyncClient, query: FareQuery) -> list[FareOffer]:
    token = travelpayouts_token()
    if not token:
        # A configuration state, not a failure of the upstream. The registry
        # needs to be able to tell them apart to decide whether falling back
        # here is even possible.
        raise FareError(
            "no-credential",
            "TRAVELPAYOUTS_TOKEN is not set; see .env.example",
            route=query.route,
        )

    try:
        response = await client.get(URL, params=_authenticated_params(query, token))
    except httpx.HTTPError as exc:
        raise FareError(
            "unreachable",
            f"Travelpayouts could not be reached: {transport_reason(exc)}",
            route=query.route,
        ) from exc

    if response.status_code == 401 or response.status_code == 403:
        raise FareError("no-credential", "Travelpayouts rejected the token", route=query.route)
    if response.status_code == 429:
        raise FareError(
            "rate-limited", "Travelpayouts is rate limiting this token", route=query.route
        )
    if response.status_code >= 400:
        raise FareError(
            "upstream-error",
            f"Travelpayouts answered {response.status_code}",
            route=query.route,
        )

    try:
        payload = response.json()
    except ValueError as exc:
        raise FareError(
            "unreadable", f"Travelpayouts answered with non-JSON: {exc}", route=query.route
        ) from exc

    try:
        return parse_payload(payload, query.currency)
    except FareError as error:
        # Re-raised with the route attached, which the parser cannot know.
        raise FareError(error.code, error.message, route=query.route) from error
