"""The guarded official-SKY fallback, exercised without a live browser."""

import asyncio
from dataclasses import replace

import pytest

from app import main
from app.adapters.fares import registry, sky_airline
from app.adapters.fares.models import FareOffer, FareQuery, SearchResult


def h2_offer(
    *,
    price: float | None = None,
    airline: str = "H2",
    flight_number: str = "1313",
    via_points: tuple[str, ...] | None = (),
    transfers: int = 0,
    duration_minutes: int | None = 120,
) -> FareOffer:
    return FareOffer(
        airline=airline,
        airline_name="SKY Airline",
        flight_number=flight_number,
        departure_at="2026-09-04T10:00",
        arrival_at="2026-09-04T12:00",
        transfers=transfers,
        duration_minutes=duration_minutes,
        price=price,
        currency="USD",
        via_points=via_points,
    )


QUERY = FareQuery("ARI", "SCL", "2026-09-04")


class FakeResultRow:
    """A complete rendered result-card fixture, not a page-wide text blob."""

    def __init__(
        self,
        *,
        total: str = "123.45",
        currency: str = "USD",
        origin: str = "ARI",
        destination: str = "SCL",
        flight_numbers: tuple[str, ...] = ("H2 1313",),
        departure: str = "2026-09-04T10:00",
        arrival: str = "2026-09-04T12:00",
        via_points: tuple[str, ...] = (),
        transfers: str = "0",
        duration: str = "120",
    ):
        self.values = {
            sky_airline.RESULT_TOTAL_SELECTOR: total,
            sky_airline.RESULT_CURRENCY_SELECTOR: currency,
            sky_airline.RESULT_ORIGIN_SELECTOR: origin,
            sky_airline.RESULT_DESTINATION_SELECTOR: destination,
            sky_airline.RESULT_DEPARTURE_SELECTOR: departure,
            sky_airline.RESULT_ARRIVAL_SELECTOR: arrival,
            sky_airline.RESULT_TRANSFERS_SELECTOR: transfers,
            sky_airline.RESULT_DURATION_SELECTOR: duration,
        }
        self.flight_numbers = list(flight_numbers)
        self.via_points = list(via_points)

    async def text_content(self, selector: str) -> str | None:
        return self.values.get(selector)

    async def all_text_contents(self, selector: str) -> list[str]:
        if selector == sky_airline.RESULT_FLIGHT_NUMBER_SELECTOR:
            return self.flight_numbers
        if selector == sky_airline.RESULT_VIA_POINT_SELECTOR:
            return self.via_points
        return []


class FakePage:
    """A rendered booking-flow fake that releases result cards only after search."""

    def __init__(
        self,
        *rows: FakeResultRow,
        currency: str = "USD",
        taxes_included: bool = True,
        usd_available: bool = True,
        unavailable: set[str] | None = None,
        error: Exception | None = None,
    ):
        self.rows = list(rows)
        self.currency = currency
        self.taxes_included = taxes_included
        self.usd_available = usd_available
        self.unavailable = unavailable or set()
        self.error = error
        self.closed = False
        self.searched = False
        self.filled: dict[str, str] = {}

    async def goto(self, _url: str) -> None:
        self._raise_if_broken()

    async def fill(self, selector: str, value: str) -> None:
        self._raise_if_broken()
        self.filled[selector] = value

    async def press(self, _selector: str, _key: str) -> None:
        self._raise_if_broken()

    async def click(self, selector: str) -> None:
        self._raise_if_broken()
        if selector == sky_airline.SEARCH_BUTTON_SELECTOR:
            self.searched = True
        elif selector == sky_airline.TAX_INCLUDED_TOGGLE_SELECTOR:
            self.taxes_included = True
        elif selector == sky_airline.USD_LOCALE_OPTION_SELECTOR and self.usd_available:
            self.currency = "USD"

    async def wait_for_selector(self, selector: str) -> None:
        self._raise_if_broken()
        if selector in self.unavailable:
            raise RuntimeError(f"missing live control: {selector}")
        if selector == sky_airline.RESULT_ROW_SELECTOR and not self.searched:
            raise RuntimeError("results were read before search")

    async def text_content(self, selector: str) -> str | None:
        self._raise_if_broken()
        if selector == sky_airline.CURRENCY_VERIFICATION_SELECTOR:
            return self.currency
        return None

    async def is_checked(self, selector: str) -> bool:
        self._raise_if_broken()
        if selector != sky_airline.TAX_INCLUDED_TOGGLE_SELECTOR:
            raise RuntimeError("unexpected control")
        return self.taxes_included

    async def result_rows(self, selector: str) -> list[FakeResultRow]:
        self._raise_if_broken()
        if selector != sky_airline.RESULT_ROW_SELECTOR or not self.searched:
            raise RuntimeError("results unavailable")
        return self.rows

    async def close(self) -> None:
        self.closed = True

    def _raise_if_broken(self) -> None:
        if self.error is not None:
            raise self.error


class FakeSession:
    def __init__(self, *pages: FakePage):
        self.pages = list(pages)
        self.opened = 0

    async def new_page(self) -> FakePage:
        self.opened += 1
        return self.pages.pop(0)


class ManagedFakeSession:
    def __init__(self, *, start_error: Exception | None = None):
        self.start_error = start_error
        self.started = False
        self.closed = False

    async def start(self) -> None:
        if self.start_error is not None:
            raise self.start_error
        self.started = True

    async def close(self) -> None:
        self.closed = True


@pytest.fixture(autouse=True)
def _clear_sky_session():
    sky_airline.set_session(None)
    yield
    sky_airline.set_session(None)


def test_matching_result_card_after_search_enriches_only_the_missing_price():
    page = FakePage(FakeResultRow())
    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(page)).enrich(QUERY, [h2_offer()])
    )

    assert result == [replace(h2_offer(), price=123.45)]
    assert page.filled == {
        sky_airline.ORIGIN_INPUT_SELECTOR: "ARI",
        sky_airline.DESTINATION_INPUT_SELECTOR: "SCL",
        sky_airline.DEPARTURE_DATE_INPUT_SELECTOR: "2026-09-04",
    }
    assert page.closed is True


@pytest.mark.parametrize(
    "page",
    [
        FakePage(FakeResultRow(currency="CLP")),
        FakePage(FakeResultRow(), currency="CLP", usd_available=False),
    ],
)
def test_currency_that_cannot_be_verified_as_usd_keeps_the_primary_null_price(page: FakePage):
    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(page)).enrich(QUERY, [h2_offer()])
    )

    assert result == [h2_offer()]


@pytest.mark.parametrize("total", ["not-a-number", "0", "-1.00", "123.456"])
def test_invalid_result_card_amount_keeps_the_primary_null_price(total: str):
    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(FakePage(FakeResultRow(total=total)))).enrich(
            QUERY, [h2_offer()]
        )
    )

    assert result == [h2_offer()]


def test_connection_with_matching_first_flight_but_different_stop_is_ambiguous():
    offer = h2_offer(flight_number="4000", via_points=("PMC",), transfers=1, duration_minutes=180)
    row = FakeResultRow(
        flight_numbers=("H2 4000", "H2 4010"), via_points=("ZCO",), transfers="1", duration="180"
    )

    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(FakePage(row))).enrich(QUERY, [offer])
    )

    assert result == [offer]


def test_matching_connection_requires_every_available_itinerary_field():
    offer = h2_offer(flight_number="4000", via_points=("PMC",), transfers=1, duration_minutes=180)
    row = FakeResultRow(
        total="210.50",
        flight_numbers=("H2 4000", "H2 4010"),
        via_points=("PMC",),
        transfers="1",
        duration="180",
    )

    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(FakePage(row))).enrich(QUERY, [offer])
    )

    assert result == [replace(offer, price=210.50)]


def test_page_error_keeps_the_primary_null_price():
    page = FakePage(FakeResultRow(), error=RuntimeError("blocked"))

    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(page)).enrich(QUERY, [h2_offer()])
    )

    assert result == [h2_offer()]


def test_missing_result_flow_control_keeps_the_primary_null_price():
    page = FakePage(FakeResultRow(), unavailable={sky_airline.TAX_INCLUDED_TOGGLE_SELECTOR})

    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(page)).enrich(QUERY, [h2_offer()])
    )

    assert result == [h2_offer()]


def test_tax_toggle_is_set_and_verified_before_accepting_a_result_card():
    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(
            FakeSession(FakePage(FakeResultRow(), taxes_included=False))
        ).enrich(QUERY, [h2_offer()])
    )

    assert result == [replace(h2_offer(), price=123.45)]


def test_two_matching_result_cards_are_ambiguous_and_keep_the_primary_null_price():
    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(
            FakeSession(FakePage(FakeResultRow(), FakeResultRow()))
        ).enrich(QUERY, [h2_offer()])
    )

    assert result == [h2_offer()]


def test_only_unpriced_h2_offers_are_eligible_for_enrichment():
    page = FakePage(FakeResultRow())
    h2_priced = h2_offer(price=77.0)
    non_h2_unpriced = h2_offer(airline="LA")

    result = asyncio.run(
        sky_airline.SkyAirlineAdapter(FakeSession(page)).enrich(QUERY, [h2_priced, non_h2_unpriced])
    )

    assert result == [h2_priced, non_h2_unpriced]
    assert page.closed is False


def test_registry_does_not_open_an_official_browser_when_the_flag_is_disabled(monkeypatch):
    session = FakeSession(FakePage(FakeResultRow()))
    sky_airline.set_session(session)
    monkeypatch.setenv("SKY_OFFICIAL_LOOKUP_ENABLED", "false")

    async def primary(_client, _query):
        return [h2_offer()]

    monkeypatch.setattr(registry.google_flights, "fetch_offers", primary)
    result = asyncio.run(registry.fetch_offers(None, QUERY))

    assert result == [h2_offer()]
    assert session.opened == 0


def test_registry_enriches_search_offers_without_losing_google_search_metadata(monkeypatch):
    sky_airline.set_session(FakeSession(FakePage(FakeResultRow())))
    monkeypatch.setenv("SKY_OFFICIAL_LOOKUP_ENABLED", "true")
    primary = SearchResult(offers=[h2_offer()])

    async def fetch_search(_client, _query):
        return primary

    monkeypatch.setattr(registry.google_flights, "fetch_search", fetch_search)
    result = asyncio.run(registry.fetch_search(None, QUERY))

    assert result.offers == [replace(h2_offer(), price=123.45)]
    assert result.history is primary.history
    assert result.insights is primary.insights
    assert result.airports is primary.airports


def test_registry_enriches_missing_h2_offers_when_the_flag_is_enabled(monkeypatch):
    sky_airline.set_session(FakeSession(FakePage(FakeResultRow())))
    monkeypatch.setenv("SKY_OFFICIAL_LOOKUP_ENABLED", "true")

    async def primary(_client, _query):
        return [h2_offer()]

    monkeypatch.setattr(registry.google_flights, "fetch_offers", primary)
    result = asyncio.run(registry.fetch_offers(None, QUERY))

    assert result == [replace(h2_offer(), price=123.45)]


def test_disabled_startup_does_not_create_or_launch_the_browser(monkeypatch):
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


def test_enabled_startup_registers_the_started_browser_session(monkeypatch):
    browser = ManagedFakeSession()
    monkeypatch.setenv("SKY_OFFICIAL_LOOKUP_ENABLED", "true")
    monkeypatch.setattr(main.sky_airline, "PlaywrightSkySession", lambda: browser)

    started = asyncio.run(main.start_official_sky_session())

    assert started is browser
    assert browser.started is True
    assert sky_airline.session() is browser


def test_failed_enabled_startup_clears_a_stale_browser_session(monkeypatch):
    sky_airline.set_session(FakeSession())
    browser = ManagedFakeSession(start_error=RuntimeError("chromium missing"))
    monkeypatch.setenv("SKY_OFFICIAL_LOOKUP_ENABLED", "true")
    monkeypatch.setattr(main.sky_airline, "PlaywrightSkySession", lambda: browser)

    started = asyncio.run(main.start_official_sky_session())

    assert started is None
    assert sky_airline.session() is None


def test_shutdown_closes_the_browser_and_clears_its_container_entry():
    browser = ManagedFakeSession()
    sky_airline.set_session(browser)

    asyncio.run(main.close_official_sky_session(browser))

    assert browser.closed is True
    assert sky_airline.session() is None
