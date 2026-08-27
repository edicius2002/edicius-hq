"""Fail-closed official SKY result-card fare confirmation.

Google supplies the primary itinerary.  This adapter drives the public SKY
search form and accepts only one rendered result card that proves USD,
tax-included state, and the complete itinerary evidence Google exposes.  Any
missing control, selector drift, ambiguity, or browser error leaves the Google
price unavailable.
"""

from __future__ import annotations

import re
from contextlib import suppress
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

from app.adapters.fares.models import FareOffer, FareQuery

SKY_HOME_URL = "https://www.skyairline.com/flights/en/"

# The two airport labels and Search were observed on the public landing page.
# The remaining controls are deliberately isolated provisional selectors: a
# live page that cannot satisfy any of them is a safe, unpriced result.
ORIGIN_INPUT_SELECTOR = '[aria-label="fc-booking-origin-aria-label"]'
DESTINATION_INPUT_SELECTOR = '[aria-label="fc-booking-destination-aria-label"]'
DEPARTURE_DATE_INPUT_SELECTOR = '[aria-label="fc-booking-departure-date-aria-label"]'
SEARCH_BUTTON_SELECTOR = 'button:has-text("Search")'
LOCALE_MENU_SELECTOR = "text=Other English"
USD_LOCALE_OPTION_SELECTOR = "text=USD"
CURRENCY_VERIFICATION_SELECTOR = '[data-testid="currency"]'
TAX_INCLUDED_TOGGLE_SELECTOR = '[data-testid="taxes-included"]'
RESULT_ROW_SELECTOR = '[data-testid="flight-result"]'
RESULT_TOTAL_SELECTOR = '[data-testid="total-price"]'
RESULT_CURRENCY_SELECTOR = '[data-testid="price-currency"]'
RESULT_ORIGIN_SELECTOR = '[data-testid="departure-airport"]'
RESULT_DESTINATION_SELECTOR = '[data-testid="arrival-airport"]'
RESULT_FLIGHT_NUMBER_SELECTOR = '[data-testid="flight-number"]'
RESULT_DEPARTURE_SELECTOR = '[data-testid="departure-time"]'
RESULT_ARRIVAL_SELECTOR = '[data-testid="arrival-time"]'
RESULT_VIA_POINT_SELECTOR = '[data-testid="connection-airport"]'
RESULT_TRANSFERS_SELECTOR = '[data-testid="transfer-count"]'
RESULT_DURATION_SELECTOR = '[data-testid="duration-minutes"]'


class SkyResultRow(Protocol):
    async def text_content(self, selector: str) -> str | None: ...

    async def all_text_contents(self, selector: str) -> list[str]: ...


class SkyPage(Protocol):
    async def goto(self, url: str) -> None: ...

    async def fill(self, selector: str, value: str) -> None: ...

    async def press(self, selector: str, key: str) -> None: ...

    async def click(self, selector: str) -> None: ...

    async def wait_for_selector(self, selector: str) -> None: ...

    async def text_content(self, selector: str) -> str | None: ...

    async def is_checked(self, selector: str) -> bool: ...

    async def result_rows(self, selector: str) -> list[SkyResultRow]: ...

    async def close(self) -> None: ...


class SkySession(Protocol):
    async def new_page(self) -> SkyPage: ...


class PlaywrightSkyResultRow:
    def __init__(self, locator: Any) -> None:
        self._locator = locator

    async def text_content(self, selector: str) -> str | None:
        return await self._locator.locator(selector).text_content()

    async def all_text_contents(self, selector: str) -> list[str]:
        return await self._locator.locator(selector).all_text_contents()


class PlaywrightSkyPage:
    """The one place the adapter maps its small protocol to Playwright DOM APIs."""

    def __init__(self, page: Any) -> None:
        self._page = page

    async def goto(self, url: str) -> None:
        await self._page.goto(url, wait_until="domcontentloaded")

    async def fill(self, selector: str, value: str) -> None:
        await self._page.locator(selector).fill(value)

    async def press(self, selector: str, key: str) -> None:
        await self._page.locator(selector).press(key)

    async def click(self, selector: str) -> None:
        await self._page.locator(selector).click()

    async def wait_for_selector(self, selector: str) -> None:
        await self._page.wait_for_selector(selector, state="visible")

    async def text_content(self, selector: str) -> str | None:
        return await self._page.locator(selector).text_content()

    async def is_checked(self, selector: str) -> bool:
        return await self._page.locator(selector).is_checked()

    async def result_rows(self, selector: str) -> list[SkyResultRow]:
        locator = self._page.locator(selector)
        return [
            PlaywrightSkyResultRow(locator.nth(index)) for index in range(await locator.count())
        ]

    async def close(self) -> None:
        await self._page.close()


class PlaywrightSkySession:
    """Own Playwright's process lifecycle without exposing it to callers."""

    def __init__(self) -> None:
        self._playwright: Any | None = None
        self._browser: Any | None = None

    async def start(self) -> None:
        if self._browser is not None:
            return
        from playwright.async_api import async_playwright

        playwright = await async_playwright().start()
        self._playwright = playwright
        try:
            self._browser = await playwright.chromium.launch(headless=True, args=["--disable-gpu"])
        except Exception:
            await playwright.stop()
            self._playwright = None
            raise

    async def new_page(self) -> SkyPage:
        if self._browser is None:
            raise RuntimeError("SKY browser session has not been started")
        return PlaywrightSkyPage(await self._browser.new_page())

    async def close(self) -> None:
        browser, playwright = self._browser, self._playwright
        self._browser = None
        self._playwright = None
        if browser is not None:
            await browser.close()
        if playwright is not None:
            await playwright.stop()


@dataclass(frozen=True, slots=True)
class RenderedFare:
    currency: str
    total: float
    origin: str
    destination: str
    flight_numbers: tuple[str, ...]
    departure_at: str
    arrival_at: str
    via_points: tuple[str, ...]
    transfers: int
    duration_minutes: int


_session: SkySession | None = None


def set_session(session: SkySession | None) -> None:
    """Set the process-owned browser session; tests inject a fake here."""
    global _session
    _session = session


def session() -> SkySession | None:
    return _session


class SkyAirlineAdapter:
    def __init__(self, browser_session: SkySession | None) -> None:
        self._session = browser_session

    async def enrich(self, query: FareQuery, offers: list[FareOffer]) -> list[FareOffer]:
        """Fill only one fully confirmed missing H2 USD price per primary offer."""
        eligible = [
            offer
            for offer in offers
            if offer.airline == "H2" and offer.price is None and offer.currency.upper() == "USD"
        ]
        if (
            self._session is None
            or query.currency.upper() != "USD"
            or query.return_date is not None
            or not eligible
        ):
            return offers

        rows = await self._search_result_cards(query)
        if rows is None:
            return offers
        enriched: list[FareOffer] = []
        for offer in offers:
            if offer not in eligible:
                enriched.append(offer)
                continue
            matches = [row.total for row in rows if _matches(query, offer, row)]
            enriched.append(replace(offer, price=matches[0]) if len(matches) == 1 else offer)
        return enriched

    async def _search_result_cards(self, query: FareQuery) -> list[RenderedFare] | None:
        page: SkyPage | None = None
        try:
            page = await self._session.new_page()  # type: ignore[union-attr]
            await page.goto(SKY_HOME_URL)
            await page.wait_for_selector(LOCALE_MENU_SELECTOR)
            await page.click(LOCALE_MENU_SELECTOR)
            await page.wait_for_selector(USD_LOCALE_OPTION_SELECTOR)
            await page.click(USD_LOCALE_OPTION_SELECTOR)
            await page.wait_for_selector(CURRENCY_VERIFICATION_SELECTOR)
            if (
                await page.text_content(CURRENCY_VERIFICATION_SELECTOR) or ""
            ).strip().upper() != "USD":
                return None

            await page.fill(ORIGIN_INPUT_SELECTOR, query.origin.upper())
            await page.press(ORIGIN_INPUT_SELECTOR, "Enter")
            await page.fill(DESTINATION_INPUT_SELECTOR, query.destination.upper())
            await page.press(DESTINATION_INPUT_SELECTOR, "Enter")
            await page.fill(DEPARTURE_DATE_INPUT_SELECTOR, query.flight_date)
            await page.press(DEPARTURE_DATE_INPUT_SELECTOR, "Enter")
            await page.click(SEARCH_BUTTON_SELECTOR)
            await page.wait_for_selector(RESULT_ROW_SELECTOR)
            await page.wait_for_selector(TAX_INCLUDED_TOGGLE_SELECTOR)
            if not await page.is_checked(TAX_INCLUDED_TOGGLE_SELECTOR):
                await page.click(TAX_INCLUDED_TOGGLE_SELECTOR)
            if not await page.is_checked(TAX_INCLUDED_TOGGLE_SELECTOR):
                return None

            rows = await page.result_rows(RESULT_ROW_SELECTOR)
            rendered = [await _parse_result_row(row) for row in rows]
            return [row for row in rendered if row is not None]
        # Browser and rendered-flow errors are failures closed to the primary null.
        except Exception:  # noqa: BLE001
            return None
        finally:
            if page is not None:
                with suppress(Exception):
                    await page.close()


async def _parse_result_row(row: SkyResultRow) -> RenderedFare | None:
    (
        total,
        currency,
        origin,
        destination,
        departure,
        arrival,
        transfers,
        duration,
    ) = await _row_values(
        row,
        RESULT_TOTAL_SELECTOR,
        RESULT_CURRENCY_SELECTOR,
        RESULT_ORIGIN_SELECTOR,
        RESULT_DESTINATION_SELECTOR,
        RESULT_DEPARTURE_SELECTOR,
        RESULT_ARRIVAL_SELECTOR,
        RESULT_TRANSFERS_SELECTOR,
        RESULT_DURATION_SELECTOR,
    )
    if (
        total is None
        or currency is None
        or origin is None
        or destination is None
        or departure is None
        or arrival is None
        or transfers is None
        or duration is None
    ):
        return None
    amount = _amount(total)
    flight_numbers = tuple(
        filter(
            None,
            (
                _flight_number(value)
                for value in await row.all_text_contents(RESULT_FLIGHT_NUMBER_SELECTOR)
            ),
        )
    )
    via_points = tuple(
        value.strip().upper()
        for value in await row.all_text_contents(RESULT_VIA_POINT_SELECTOR)
        if value.strip()
    )
    try:
        transfer_count = int(transfers.strip())
        duration_minutes = int(duration.strip())
    except ValueError:
        return None
    if (
        currency.strip().upper() != "USD"
        or amount is None
        or not flight_numbers
        or transfer_count < 0
        or duration_minutes <= 0
        or len(flight_numbers) != transfer_count + 1
        or len(via_points) != transfer_count
    ):
        return None
    return RenderedFare(
        currency="USD",
        total=amount,
        origin=origin.strip().upper(),
        destination=destination.strip().upper(),
        flight_numbers=flight_numbers,
        departure_at=departure.strip(),
        arrival_at=arrival.strip(),
        via_points=via_points,
        transfers=transfer_count,
        duration_minutes=duration_minutes,
    )


async def _row_values(row: SkyResultRow, *selectors: str) -> tuple[str | None, ...]:
    return tuple([await row.text_content(selector) for selector in selectors])


def _amount(value: str) -> float | None:
    if not re.fullmatch(r"[0-9]+(?:\.[0-9]{1,2})?", value.strip()):
        return None
    try:
        amount = Decimal(value)
    except InvalidOperation:
        return None
    return float(amount) if amount.is_finite() and amount > 0 else None


def _flight_number(value: str) -> str | None:
    digits = "".join(
        character
        for character in re.sub(r"^\s*H2\s*", "", value, flags=re.I)
        if character.isdigit()
    )
    return digits or None


def _matches(query: FareQuery, offer: FareOffer, rendered: RenderedFare) -> bool:
    """Use every matching field Google supplies; absent connection data is unsafe."""
    expected_flight = _flight_number(offer.flight_number or "")
    if expected_flight is None or offer.via_points is None or offer.duration_minutes is None:
        return False
    return (
        rendered.currency == "USD"
        and rendered.origin == query.origin.upper()
        and rendered.destination == query.destination.upper()
        and rendered.flight_numbers[0] == expected_flight
        and rendered.departure_at == offer.departure_at
        and rendered.arrival_at == offer.arrival_at
        and rendered.via_points == tuple(point.upper() for point in offer.via_points)
        and rendered.transfers == offer.transfers
        and rendered.duration_minutes == offer.duration_minutes
    )


async def enrich_missing_h2_prices(query: FareQuery, offers: list[FareOffer]) -> list[FareOffer]:
    """Use the process-owned official session, if startup supplied one."""
    return await SkyAirlineAdapter(session()).enrich(query, offers)
