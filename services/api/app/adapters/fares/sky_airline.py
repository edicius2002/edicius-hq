"""Fail-closed SKY (H2) price enrichment through its public booking API."""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass, replace
from datetime import datetime
from decimal import Decimal, InvalidOperation
from time import monotonic
from typing import Any

import httpx

from app.adapters.fares.models import FareOffer, FareQuery

IMPORTMAP_URL = "https://storage.googleapis.com/importmap-initial-sale/PROD/importmap.json"
SEARCH_URL = "https://api.skyairline.com/farequoting/v1/search/flight?stage=IS"
FLIGHT_SELECTOR_IMPORT = "@skyairline/is-flight-selector"
SUBSCRIPTION_KEY_HEADER = "ocp-apim-subscription-key"
REQUEST_GAP_SECONDS = 2.5

_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"
)
_KEY = re.compile(
    r'ocp-apim-subscription-key.{0,200}?["\'](?P<key>[0-9a-f]{32})["\']', re.IGNORECASE
)
_STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$")

_subscription_key: str | None = None
_last_request_at = 0.0
_key_lock = asyncio.Lock()
_request_lock = asyncio.Lock()


@dataclass(frozen=True, slots=True)
class OfficialFare:
    """One priced SKY itinerary whose total explicitly includes its taxes."""

    airline: str
    flight_number: str
    origin: str
    destination: str
    departure_at: str
    arrival_at: str
    via_points: tuple[str, ...]
    transfers: int
    duration_minutes: int
    total: float


def clear_subscription_key() -> None:
    """Reset process cache; exposed for deterministic tests and no other caller."""
    global _subscription_key, _last_request_at
    _subscription_key = None
    _last_request_at = 0.0


async def _request(
    client: httpx.AsyncClient, method: str, url: str, **kwargs: Any
) -> httpx.Response:
    """Keep unauthenticated SKY traffic deliberately slow, including key refreshes."""
    global _last_request_at
    async with _request_lock:
        wait = _last_request_at + REQUEST_GAP_SECONDS - monotonic()
        if wait > 0:
            await asyncio.sleep(wait)
        _last_request_at = monotonic()
    return await client.request(method, url, **kwargs)


async def subscription_key(client: httpx.AsyncClient, *, refresh: bool = False) -> str:
    """Discover the public APIM key from SKY's current import-map bundle."""
    global _subscription_key
    if _subscription_key is not None and not refresh:
        return _subscription_key

    # Re-check inside the lock so concurrent first boards share one discovery.
    async with _key_lock:
        if _subscription_key is not None and not refresh:
            return _subscription_key

        imports_response = await _request(
            client, "GET", IMPORTMAP_URL, headers={"User-Agent": _USER_AGENT}
        )
        imports_response.raise_for_status()
        import_map = imports_response.json()
        imports = import_map.get("imports") if isinstance(import_map, dict) else None
        selector_url = imports.get(FLIGHT_SELECTOR_IMPORT) if isinstance(imports, dict) else None
        if not isinstance(selector_url, str) or not selector_url:
            raise ValueError("SKY import map did not name the flight-selector bundle")

        selector_response = await _request(
            client, "GET", selector_url, headers={"User-Agent": _USER_AGENT}
        )
        selector_response.raise_for_status()
        match = _KEY.search(selector_response.text)
        if match is None:
            raise ValueError("SKY flight-selector bundle did not contain a subscription key")
        _subscription_key = match.group("key")
        return _subscription_key


def _search_body(query: FareQuery) -> dict[str, object]:
    return {
        "cabinClass": "Economy",
        "currency": "USD",
        "awardBooking": False,
        "pointOfSale": "PR",
        "searchType": "BRANDED",
        "itineraryParts": [
            {
                "origin": {"code": query.origin.upper(), "useNearbyLocations": False},
                "destination": {"code": query.destination.upper(), "useNearbyLocations": False},
                "departureDate": {"date": query.flight_date},
                "selectedOfferRef": None,
                "plusMinusDays": None,
            }
        ],
        "passengers": {"ADT": 1, "CHD": 0, "INF": 0, "PET": 0},
        "trendIndicator": None,
        "preferredOperatingCarrier": None,
    }


def _search_headers(key: str) -> dict[str, str]:
    return {
        "Content-Type": "application/json",
        "Accept-Language": "en-US",
        "Channel": "WEB",
        "HomeMarket": "OTHERS",
        SUBSCRIPTION_KEY_HEADER: key,
        "Origin": "https://initial-sale.skyairline.com",
        "Referer": "https://initial-sale.skyairline.com/",
        "User-Agent": _USER_AGENT,
    }


async def _post_search(client: httpx.AsyncClient, query: FareQuery, key: str) -> httpx.Response:
    return await _request(
        client,
        "POST",
        SEARCH_URL,
        headers=_search_headers(key),
        json=_search_body(query),
    )


def _money(node: Any, *, allow_zero: bool = False) -> Decimal | None:
    if not isinstance(node, dict) or str(node.get("currency", "")).upper() != "USD":
        return None
    value = node.get("amount")
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        return None
    try:
        amount = Decimal(str(value))
    except InvalidOperation:
        return None
    if not amount.is_finite() or amount < 0 or (amount == 0 and not allow_zero):
        return None
    return amount


def _stamp(value: Any) -> str | None:
    if not isinstance(value, str) or _STAMP.fullmatch(value) is None:
        return None
    try:
        return datetime.fromisoformat(value).strftime("%Y-%m-%dT%H:%M")
    except ValueError:
        return None


def _segment_value(segment: Any, name: str) -> str | None:
    value = segment.get(name) if isinstance(segment, dict) else None
    return value.strip().upper() if isinstance(value, str) and value.strip() else None


def _selected_total(fares: Any) -> Decimal | None:
    if not isinstance(fares, list) or not fares:
        return None
    valid: list[Decimal] = []
    for branded_fare in fares:
        if not isinstance(branded_fare, dict) or branded_fare.get("status") is not True:
            continue
        total = _money(branded_fare.get("total"))
        by_passenger = branded_fare.get("priceByPassengerTypes")
        if not isinstance(by_passenger, list) or len(by_passenger) != 1:
            continue
        adult = by_passenger[0]
        if not isinstance(adult, dict) or adult.get("requestedPassengerType") != "ADT":
            continue
        fare, taxes, passenger_total = (
            _money(adult.get("fare")),
            _money(adult.get("taxes"), allow_zero=True),
            _money(adult.get("total")),
        )
        if (
            total is None
            or fare is None
            or taxes is None
            or passenger_total is None
            or passenger_total != total
            or fare + taxes != total
        ):
            # The minimum is not trustworthy if it lacks the explicit tax proof.
            return None
        valid.append(total)
    return min(valid, default=None)


def _official_fare(itinerary: Any) -> OfficialFare | None:
    if not isinstance(itinerary, dict):
        return None
    segments = itinerary.get("segments")
    stops, duration = itinerary.get("stops"), itinerary.get("totalDuration")
    if (
        not isinstance(segments, list)
        or not segments
        or isinstance(stops, bool)
        or not isinstance(stops, int)
        or stops != len(segments) - 1
        or isinstance(duration, bool)
        or not isinstance(duration, int)
        or duration <= 0
    ):
        return None

    first, last = segments[0], segments[-1]
    first_flight = first.get("flight") if isinstance(first, dict) else None
    airline = first_flight.get("airlineCode") if isinstance(first_flight, dict) else None
    flight_number = first_flight.get("flightNumber") if isinstance(first_flight, dict) else None
    if not isinstance(airline, str) or not isinstance(flight_number, (int, str)):
        return None
    origin, destination = _segment_value(first, "origin"), _segment_value(last, "destination")
    departure, arrival = (
        _stamp(first.get("departure") if isinstance(first, dict) else None),
        _stamp(last.get("arrival") if isinstance(last, dict) else None),
    )
    via_points = tuple(_segment_value(segment, "destination") for segment in segments[:-1])
    total = _selected_total(itinerary.get("fares"))
    if (
        origin is None
        or destination is None
        or departure is None
        or arrival is None
        or any(point is None for point in via_points)
        or total is None
    ):
        return None
    return OfficialFare(
        airline=airline.upper(),
        flight_number=str(flight_number),
        origin=origin,
        destination=destination,
        departure_at=departure,
        arrival_at=arrival,
        via_points=tuple(point for point in via_points if point is not None),
        transfers=stops,
        duration_minutes=duration,
        total=float(total),
    )


def parse_search_response(payload: Any) -> list[OfficialFare]:
    """Read only complete, tax-accounted itineraries from the booking response."""
    parts = payload.get("itineraryParts") if isinstance(payload, dict) else None
    if not isinstance(parts, list) or len(parts) != 1 or not isinstance(parts[0], list):
        return []
    return [fare for item in parts[0] if (fare := _official_fare(item)) is not None]


async def fetch_official_fares(client: httpx.AsyncClient, query: FareQuery) -> list[OfficialFare]:
    """One public booking-API call, retrying exactly once if SKY rotated its key."""
    if query.return_date is not None or query.currency.upper() != "USD":
        return []
    try:
        key = await subscription_key(client)
        response = await _post_search(client, query, key)
        if response.status_code == 401:
            key = await subscription_key(client, refresh=True)
            response = await _post_search(client, query, key)
        if response.status_code >= 400:
            return []
        return parse_search_response(response.json())
    except (httpx.HTTPError, ValueError, TypeError):
        return []


def _matches(query: FareQuery, offer: FareOffer, official: OfficialFare) -> bool:
    if (
        offer.flight_number is None
        or offer.arrival_at is None
        or offer.via_points is None
        or offer.duration_minutes is None
    ):
        return False
    return (
        official.airline == offer.airline.upper() == "H2"
        and official.flight_number == re.sub(r"^H2", "", offer.flight_number, flags=re.IGNORECASE)
        and official.origin == query.origin.upper()
        and official.destination == query.destination.upper()
        and official.departure_at == offer.departure_at
        and official.arrival_at == offer.arrival_at
        and official.via_points == tuple(point.upper() for point in offer.via_points)
        and official.transfers == offer.transfers
        and official.duration_minutes == offer.duration_minutes
    )


async def enrich_missing_h2_prices(
    client: httpx.AsyncClient, query: FareQuery, offers: list[FareOffer]
) -> list[FareOffer]:
    """Replace Google nulls only when one official itinerary corroborates every field."""
    eligible = [
        offer
        for offer in offers
        if offer.airline.upper() == "H2" and offer.price is None and offer.currency.upper() == "USD"
    ]
    if not eligible:
        return offers
    official_fares = await fetch_official_fares(client, query)
    if not official_fares:
        return offers
    enriched: list[FareOffer] = []
    for offer in offers:
        matches = [fare.total for fare in official_fares if _matches(query, offer, fare)]
        enriched.append(replace(offer, price=matches[0]) if len(matches) == 1 else offer)
    return enriched
