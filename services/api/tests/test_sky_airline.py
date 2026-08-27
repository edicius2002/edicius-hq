"""The guarded official-SKY fallback, exercised without a live browser."""

import asyncio
from dataclasses import replace

import pytest

from app import main
from app.adapters.fares import registry, sky_airline
from app.adapters.fares.models import FareOffer, FareQuery


def h2_offer(*, price: float | None = None, airline: str = "H2") -> FareOffer:
    return FareOffer(
        airline=airline,
        airline_name="SKY Airline",
        flight_number="1313",
        departure_at="2026-09-04T10:00",
        arrival_at="2026-09-04T12:00",
        transfers=0,
        duration_minutes=120,
        price=price,
        currency="USD",
        via_points=(),
    )


QUERY = FareQuery("ARI", "SCL", "2026-09-04")


def confirmed_rendered_offer(*, total: str = "123.45") -> str:
    return f"""
        CURRENCY: USD
        TAXES: INCLUDED
        ROUTE: ARI-SCL
        FLIGHT: H2 1313
        DEPARTURE: 2026-09-04T10:00
        ARRIVAL: 2026-09-04T12:00
        TOTAL: USD {total}
    """


class FakePage:
    """The smallest rendered-page contract the adapter needs."""

    def __init__(self, body: str, *, error: Exception | None = None):
        self.body = body
        self.error = error
        self.closed = False

    async def goto(self, url: str) -> None:
        if self.error is not None:
            raise self.error

    async def text_content(self, selector: str) -> str | None:
        assert selector == sky_airline.BODY_SELECTOR
        return self.body

    async def close(self) -> None:
        self.closed = True


class FakeSession:
    def __init__(self, *pages: FakePage):
        self.pages = list(pages)
        self.opened = 0

    async def new_page(self) -> FakePage:
        self.opened += 1
        return self.pages.pop(0)


@pytest.fixture(autouse=True)
def _clear_sky_session():
    sky_airline.set_session(None)
    yield
    sky_airline.set_session(None)


def test_confirmed_usd_tax_included_matching_offer_enriches_only_its_price():
    page = FakePage(confirmed_rendered_offer())
    result = asyncio.run(sky_airline.SkyAirlineAdapter(FakeSession(page)).enrich(QUERY, [h2_offer()]))

    assert result == [replace(h2_offer(), price=123.45)]
    assert page.closed is True


@pytest.mark.parametrize(
    "body",
    [
        confirmed_rendered_offer().replace("CURRENCY: USD", "CURRENCY: CLP"),
        confirmed_rendered_offer().replace("TAXES: INCLUDED", "TAXES: EXCLUDED"),
    ],
)
def test_currency_or_tax_ambiguity_keeps_the_primary_null_price(body: str):
    result = asyncio.run(sky_airline.SkyAirlineAdapter(FakeSession(FakePage(body))).enrich(QUERY, [h2_offer()]))

    assert result == [h2_offer()]


@pytest.mark.parametrize("total", ["not-a-number", "0", "-1.00", "123.456"])
def test_invalid_rendered_amount_keeps_the_primary_null_price(total: str):
    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(FakePage(confirmed_rendered_offer(total=total)))).enrich(
            QUERY, [h2_offer()]
        )
    )

    assert result == [h2_offer()]


def test_itinerary_mismatch_keeps_the_primary_null_price():
    body = confirmed_rendered_offer().replace("FLIGHT: H2 1313", "FLIGHT: H2 9999")

    result = asyncio.run(sky_airline.SkyAirlineAdapter(FakeSession(FakePage(body))).enrich(QUERY, [h2_offer()]))

    assert result == [h2_offer()]


def test_page_error_keeps_the_primary_null_price():
    page = FakePage("", error=RuntimeError("blocked"))

    result = asyncio.run(sky_airline.SkyAirlineAdapter(FakeSession(page)).enrich(QUERY, [h2_offer()]))

    assert result == [h2_offer()]


def test_only_unpriced_h2_offers_are_eligible_for_enrichment():
    page = FakePage(confirmed_rendered_offer())
    h2_priced = h2_offer(price=77.0)
    non_h2_unpriced = h2_offer(airline="LA")

    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(page)).enrich(
            QUERY, [h2_priced, non_h2_unpriced]
        )
    )

    assert result == [h2_priced, non_h2_unpriced]
    assert page.closed is False


def test_registry_does_not_open_an_official_browser_when_the_flag_is_disabled(monkeypatch):
    session = FakeSession(FakePage(confirmed_rendered_offer()))
    sky_airline.set_session(session)
    monkeypatch.setenv("SKY_OFFICIAL_LOOKUP_ENABLED", "false")

    async def primary(_client, _query):
        return [h2_offer()]

    monkeypatch.setattr(registry.google_flights, "fetch_offers", primary)
    result = asyncio.run(registry.fetch_offers(None, QUERY))

    assert result == [h2_offer()]
    assert session.opened == 0


def test_registry_enriches_missing_h2_price_only_when_the_flag_is_enabled(monkeypatch):
    sky_airline.set_session(FakeSession(FakePage(confirmed_rendered_offer())))
    monkeypatch.setenv("SKY_OFFICIAL_LOOKUP_ENABLED", "true")

    async def primary(_client, _query):
        return [h2_offer()]

    monkeypatch.setattr(registry.google_flights, "fetch_offers", primary)
    result = asyncio.run(registry.fetch_offers(None, QUERY))

    assert result == [replace(h2_offer(), price=123.45)]


def test_disabled_feature_flag_does_not_create_or_launch_the_browser(monkeypatch):
    created = 0

    class UnexpectedBrowser:
        def __init__(self):
            nonlocal created
            created += 1

    monkeypatch.setenv("SKY_OFFICIAL_LOOKUP_ENABLED", "false")
    monkeypatch.setattr(main.sky_airline, "PlaywrightSkySession", UnexpectedBrowser)
    sky_airline.set_session(FakeSession())

    started = asyncio.run(main.start_official_sky_session())

    assert started is None
    assert created == 0
    assert sky_airline.session() is None
