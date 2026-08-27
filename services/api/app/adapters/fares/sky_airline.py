"""Fail-closed, opt-in official SKY fare confirmation.

This is deliberately a narrow browser boundary.  Google Flights remains the
source of the itinerary; this adapter may replace only a missing USD price once
the rendered official flow explicitly confirms currency, taxes, and identity.
The textual labels below are a *test contract*, not verified live selectors.
Until a live flow is verified, any different rendering simply leaves the
primary price unavailable.
"""

from __future__ import annotations

import re
from contextlib import suppress
from dataclasses import dataclass, replace
from decimal import Decimal, InvalidOperation
from typing import Any, Protocol

from app.adapters.fares.models import FareOffer, FareQuery

SKY_HOME_URL = "https://www.skyairline.com/"
BODY_SELECTOR = "body"


class SkyPage(Protocol):
    """The deliberately small Playwright page surface the adapter needs."""

    async def goto(self, url: str) -> None: ...

    async def text_content(self, selector: str) -> str | None: ...

    async def close(self) -> None: ...


class SkySession(Protocol):
    async def new_page(self) -> SkyPage: ...


@dataclass(frozen=True, slots=True)
class RenderedFare:
    currency: str
    taxes_included: bool
    origin: str
    destination: str
    flight_number: str
    departure_at: str
    arrival_at: str
    total: float


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
        return await self._browser.new_page()

    async def close(self) -> None:
        browser, playwright = self._browser, self._playwright
        self._browser = None
        self._playwright = None
        if browser is not None:
            await browser.close()
        if playwright is not None:
            await playwright.stop()


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
        """Fill only confirmed missing H2 USD prices, retaining every failure."""
        if (
            self._session is None
            or query.currency.upper() != "USD"
            or query.return_date is not None
        ):
            return offers

        enriched: list[FareOffer] = []
        for offer in offers:
            if offer.airline != "H2" or offer.price is not None or offer.currency.upper() != "USD":
                enriched.append(offer)
                continue
            price = await self._confirmed_price(query, offer)
            enriched.append(replace(offer, price=price) if price is not None else offer)
        return enriched

    async def _confirmed_price(self, query: FareQuery, offer: FareOffer) -> float | None:
        page: SkyPage | None = None
        try:
            page = await self._session.new_page()  # type: ignore[union-attr]
            # No form input occurs until selectors are verified against the live
            # flow. Navigating and reading rendered text is harmless and, with
            # the strict parser below, defaults to unavailable rather than guess.
            await page.goto(SKY_HOME_URL)
            rendered = _parse_rendered_fare(await page.text_content(BODY_SELECTOR))
            if rendered is None or not _matches(query, offer, rendered):
                return None
            return rendered.total
        # The external browser flow is explicitly best-effort: any navigation,
        # rendering, or selector failure must preserve the primary null.
        except Exception:  # noqa: BLE001
            return None
        finally:
            if page is not None:
                # Closing an already-disconnected page cannot turn a safe miss
                # into a request failure.
                with suppress(Exception):
                    await page.close()


def _one(body: str, pattern: str) -> tuple[str, ...] | None:
    matches = re.findall(pattern, body, flags=re.IGNORECASE | re.MULTILINE)
    if len(matches) != 1:
        return None
    match = matches[0]
    return match if isinstance(match, tuple) else (match,)


def _parse_rendered_fare(body: str | None) -> RenderedFare | None:
    if not body:
        return None
    currency = _one(body, r"^\s*CURRENCY:\s*([A-Z]{3})\s*$")
    taxes = _one(body, r"^\s*TAXES:\s*(INCLUDED|EXCLUDED)\s*$")
    route = _one(body, r"^\s*ROUTE:\s*([A-Z]{3})-([A-Z]{3})\s*$")
    flight = _one(body, r"^\s*FLIGHT:\s*(?:H2\s*)?(\d+)\s*$")
    departure = _one(body, r"^\s*DEPARTURE:\s*(\S+)\s*$")
    arrival = _one(body, r"^\s*ARRIVAL:\s*(\S+)\s*$")
    total = _one(body, r"^\s*TOTAL:\s*([A-Z]{3})\s+([0-9]+(?:\.[0-9]{1,2})?)\s*$")
    if (
        currency is None
        or taxes is None
        or route is None
        or flight is None
        or departure is None
        or arrival is None
        or total is None
    ):
        return None
    if currency[0].upper() != "USD" or total[0].upper() != "USD" or taxes[0].upper() != "INCLUDED":
        return None
    try:
        amount = Decimal(total[1])
    except InvalidOperation:
        return None
    if not amount.is_finite() or amount <= 0:
        return None
    return RenderedFare(
        currency="USD",
        taxes_included=True,
        origin=route[0].upper(),
        destination=route[1].upper(),
        flight_number=flight[0],
        departure_at=departure[0],
        arrival_at=arrival[0],
        total=float(amount),
    )


def _flight_number(value: str | None) -> str | None:
    if value is None:
        return None
    digits = "".join(character for character in value if character.isdigit())
    return digits or None


def _matches(query: FareQuery, offer: FareOffer, rendered: RenderedFare) -> bool:
    """Require the complete identity the primary offer makes available."""
    return (
        rendered.currency == "USD"
        and rendered.taxes_included
        and rendered.origin == query.origin.upper()
        and rendered.destination == query.destination.upper()
        and _flight_number(offer.flight_number) == rendered.flight_number
        and offer.departure_at == rendered.departure_at
        and offer.arrival_at is not None
        and offer.arrival_at == rendered.arrival_at
    )


async def enrich_missing_h2_prices(query: FareQuery, offers: list[FareOffer]) -> list[FareOffer]:
    """Use the process-owned official session, if startup supplied one."""
    return await SkyAirlineAdapter(session()).enrich(query, offers)
