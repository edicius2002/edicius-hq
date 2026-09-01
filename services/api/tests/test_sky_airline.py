"""The fail-closed official SKY booking-API fallback."""

import asyncio
import json
from dataclasses import replace
from pathlib import Path

import httpx
import pytest

from app.adapters.fares import registry, sky_airline
from app.adapters.fares.models import FareOffer, FareQuery, SearchResult

FIXTURES = Path(__file__).parent / "fixtures"
QUERY = FareQuery("AQP", "LIM", "2026-12-15")


def h2_offer(*, price: float | None = None, departure_at: str = "2026-12-15T06:50") -> FareOffer:
    return FareOffer(
        airline="H2",
        airline_name="SKY Airline",
        flight_number="5102",
        departure_at=departure_at,
        arrival_at="2026-12-15T08:35",
        transfers=0,
        duration_minutes=105,
        price=price,
        currency="USD",
        via_points=(),
    )


def captured_response() -> dict[str, object]:
    return json.loads((FIXTURES / "sky_farequoting_aqp_lim_2026-12-15.json").read_text())


@pytest.fixture(autouse=True)
def _clear_sky_key(monkeypatch: pytest.MonkeyPatch):
    sky_airline.clear_subscription_key()
    monkeypatch.setattr(sky_airline, "REQUEST_GAP_SECONDS", 0)
    yield
    sky_airline.clear_subscription_key()


def test_captured_response_uses_lowest_total_including_explicit_taxes():
    fares = sky_airline.parse_search_response(captured_response())

    assert fares[0] == sky_airline.OfficialFare(
        airline="H2",
        flight_number="5102",
        origin="AQP",
        destination="LIM",
        departure_at="2026-12-15T06:50",
        arrival_at="2026-12-15T08:35",
        via_points=(),
        transfers=0,
        duration_minutes=105,
        total=43.96,
    )


def test_missing_taxes_on_the_cheapest_brand_rejects_that_itinerary():
    payload = captured_response()
    cheapest = payload["itineraryParts"][0][0]["fares"][0]
    del cheapest["priceByPassengerTypes"][0]["taxes"]

    assert all(fare.flight_number != "5102" for fare in sky_airline.parse_search_response(payload))


def test_matching_number_with_a_different_timestamp_keeps_google_null(
    monkeypatch: pytest.MonkeyPatch,
):
    async def official(_client: httpx.AsyncClient, _query: FareQuery):
        return sky_airline.parse_search_response(captured_response())

    monkeypatch.setattr(sky_airline, "fetch_official_fares", official)
    offer = h2_offer(departure_at="2026-12-15T06:51")

    assert asyncio.run(sky_airline.enrich_missing_h2_prices(None, QUERY, [offer])) == [offer]


def test_matching_h2_itinerary_uses_the_tax_inclusive_total(monkeypatch: pytest.MonkeyPatch):
    async def official(_client: httpx.AsyncClient, _query: FareQuery):
        return sky_airline.parse_search_response(captured_response())

    monkeypatch.setattr(sky_airline, "fetch_official_fares", official)

    assert asyncio.run(sky_airline.enrich_missing_h2_prices(None, QUERY, [h2_offer()])) == [
        replace(h2_offer(), price=43.96)
    ]


def test_priced_or_non_h2_offers_do_not_trigger_an_official_request(
    monkeypatch: pytest.MonkeyPatch,
):
    called = False

    async def official(_client: httpx.AsyncClient, _query: FareQuery):
        nonlocal called
        called = True
        return []

    monkeypatch.setattr(sky_airline, "fetch_official_fares", official)
    non_h2 = replace(h2_offer(), airline="LA", price=None)

    assert asyncio.run(
        sky_airline.enrich_missing_h2_prices(None, QUERY, [h2_offer(price=43.96), non_h2])
    ) == [
        h2_offer(price=43.96),
        non_h2,
    ]
    assert called is False


def test_401_refreshes_the_process_cached_key_once_and_retries_the_search():
    calls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url == sky_airline.IMPORTMAP_URL:
            return httpx.Response(
                200,
                json={
                    "imports": {
                        "@skyairline/is-flight-selector": "https://example.test/selector.js"
                    }
                },
            )
        if request.url == "https://example.test/selector.js":
            key = "1" * 32 if calls.count(str(request.url)) == 1 else "2" * 32
            return httpx.Response(200, text=f'"ocp-apim-subscription-key":"{key}"')
        if request.url == sky_airline.SEARCH_URL and calls.count(str(request.url)) == 1:
            return httpx.Response(401, text="missing subscription key")
        if request.url == sky_airline.SEARCH_URL:
            return httpx.Response(200, json=captured_response())
        raise AssertionError(f"unexpected request: {request.url}")

    async def fetch():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await sky_airline.fetch_official_fares(client, QUERY)

    fares = asyncio.run(fetch())

    assert fares[0].total == 43.96
    assert calls.count(sky_airline.IMPORTMAP_URL) == 2
    assert calls.count("https://example.test/selector.js") == 2
    assert calls.count(sky_airline.SEARCH_URL) == 2


def test_key_discovery_ignores_an_unrelated_32_hex_bundle_value():
    async def handler(request: httpx.Request) -> httpx.Response:
        if request.url == sky_airline.IMPORTMAP_URL:
            return httpx.Response(
                200,
                json={
                    "imports": {
                        "@skyairline/is-flight-selector": "https://example.test/selector.js"
                    }
                },
            )
        return httpx.Response(
            200,
            text='"00000000000000000000000000000000";'
            '"ocp-apim-subscription-key":"11111111111111111111111111111111"',
        )

    async def discover():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await sky_airline.subscription_key(client)

    assert asyncio.run(discover()) == "1" * 32


def test_unexpected_import_map_shape_keeps_the_google_null():
    async def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[])

    async def fetch():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await sky_airline.fetch_official_fares(client, QUERY)

    assert asyncio.run(fetch()) == []


def test_explicit_zero_usd_taxes_are_included_in_a_valid_total():
    payload = captured_response()
    cheapest = payload["itineraryParts"][0][0]["fares"][0]
    adult = cheapest["priceByPassengerTypes"][0]
    adult["taxes"]["amount"] = 0
    adult["total"]["amount"] = 31
    cheapest["total"]["amount"] = 31

    fare = next(
        fare for fare in sky_airline.parse_search_response(payload) if fare.flight_number == "5102"
    )

    assert fare.total == 31


def test_concurrent_key_lookups_share_one_import_map_and_bundle_fetch():
    calls: list[str] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        calls.append(str(request.url))
        if request.url == sky_airline.IMPORTMAP_URL:
            await asyncio.sleep(0)
            return httpx.Response(
                200,
                json={
                    "imports": {
                        "@skyairline/is-flight-selector": "https://example.test/selector.js"
                    }
                },
            )
        return httpx.Response(
            200, text='"ocp-apim-subscription-key":"11111111111111111111111111111111"'
        )

    async def discover():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await asyncio.gather(
                sky_airline.subscription_key(client), sky_airline.subscription_key(client)
            )

    assert asyncio.run(discover()) == ["1" * 32, "1" * 32]
    assert calls == [sky_airline.IMPORTMAP_URL, "https://example.test/selector.js"]


def test_search_request_is_one_way_usd_with_the_public_booking_contract():
    requests: list[httpx.Request] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url == sky_airline.IMPORTMAP_URL:
            return httpx.Response(
                200,
                json={
                    "imports": {
                        "@skyairline/is-flight-selector": "https://example.test/selector.js"
                    }
                },
            )
        if request.url == "https://example.test/selector.js":
            return httpx.Response(
                200, text='"ocp-apim-subscription-key":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"'
            )
        return httpx.Response(200, json=captured_response())

    async def fetch():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await sky_airline.fetch_official_fares(client, QUERY)

    asyncio.run(fetch())
    request = next(request for request in requests if request.url == sky_airline.SEARCH_URL)

    assert request.headers[sky_airline.SUBSCRIPTION_KEY_HEADER] == "a" * 32
    assert request.headers["channel"] == "WEB"
    assert request.headers["homemarket"] == "OTHERS"
    assert json.loads(request.content) == {
        "cabinClass": "Economy",
        "currency": "USD",
        "awardBooking": False,
        "pointOfSale": "PR",
        "searchType": "BRANDED",
        "itineraryParts": [
            {
                "origin": {"code": "AQP", "useNearbyLocations": False},
                "destination": {"code": "LIM", "useNearbyLocations": False},
                "departureDate": {"date": "2026-12-15"},
                "selectedOfferRef": None,
                "plusMinusDays": None,
            }
        ],
        "passengers": {"ADT": 1, "CHD": 0, "INF": 0, "PET": 0},
        "trendIndicator": None,
        "preferredOperatingCarrier": None,
    }


def test_registry_passes_the_google_client_to_the_enabled_official_lookup(
    monkeypatch: pytest.MonkeyPatch,
):
    query = FareQuery("AQP", "LIM", "2026-12-15")
    offer = FareOffer(
        airline="H2",
        airline_name="SKY Airline",
        flight_number="5102",
        departure_at="2026-12-15T06:50",
        arrival_at="2026-12-15T08:35",
        transfers=0,
        duration_minutes=105,
        price=None,
        currency="USD",
        via_points=(),
    )
    client = object()
    monkeypatch.setenv("SKY_OFFICIAL_LOOKUP_ENABLED", "true")

    async def google(seen_client, _query):
        assert seen_client is client
        return SearchResult(offers=[offer])

    async def enrich(seen_client, seen_query, seen_offers):
        assert seen_client is client
        assert seen_query == query
        return [replace(seen_offers[0], price=43.96)]

    monkeypatch.setattr(registry.google_flights, "fetch_search", google)
    monkeypatch.setattr(sky_airline, "enrich_missing_h2_prices", enrich)

    assert asyncio.run(registry.fetch_search(client, query)).offers == [replace(offer, price=43.96)]
