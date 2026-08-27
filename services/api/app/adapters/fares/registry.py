"""
Which provider answers a fare query.

The same indirection `app.adapters.registry` provides for market data, and for
the same reason — decision 8.3. A caller asks for LIM-SCL and gets offers
without learning who answered, so swapping providers is a change here and
nowhere else.

Only one provider is wired today. That is not an argument against the seam: the
one provider we have is a scraper of an undocumented payload, which is exactly
the kind of dependency you want to be able to replace without touching the
router, the collector or the page.
"""

from dataclasses import replace

import httpx

from app.adapters.fares import google_flights, sky_airline
from app.adapters.fares.models import (
    CalendarPrice,
    CalendarQuery,
    FareError,
    FareOffer,
    FareQuery,
    SearchResult,
)
from app.config import sky_official_lookup_enabled

DEFAULT_PROVIDER = google_flights.PROVIDER

PROVIDERS = (google_flights.PROVIDER,)


def normalize_code(code: str) -> str:
    return code.strip().upper()


async def fetch_search(
    client: httpx.AsyncClient,
    query: FareQuery,
    *,
    provider: str = DEFAULT_PROVIDER,
) -> SearchResult:
    """Everything one search answered with, from whichever provider is wired."""
    if provider == google_flights.PROVIDER:
        result = await google_flights.fetch_search(client, query)
        if sky_official_lookup_enabled():
            return replace(
                result,
                offers=await sky_airline.enrich_missing_h2_prices(query, result.offers),
            )
        return result
    raise FareError("unknown-provider", f"No fare provider named {provider!r}", route=query.route)


async def fetch_offers(
    client: httpx.AsyncClient,
    query: FareQuery,
    *,
    provider: str = DEFAULT_PROVIDER,
) -> list[FareOffer]:
    if provider == google_flights.PROVIDER:
        offers = await google_flights.fetch_offers(client, query)
        if sky_official_lookup_enabled():
            return await sky_airline.enrich_missing_h2_prices(query, offers)
        return offers
    raise FareError("unknown-provider", f"No fare provider named {provider!r}", route=query.route)


async def fetch_calendar(
    client: httpx.AsyncClient,
    query: CalendarQuery,
    *,
    provider: str = DEFAULT_PROVIDER,
) -> list[CalendarPrice]:
    """
    The cheapest fare on every departure date in a window.

    A second seam beside `fetch_search` rather than a flag on it. A provider can
    perfectly well answer one and not the other — this one exists because
    Google's price graph does, and a replacement that could only price single
    departures should be able to say so by not implementing this.
    """
    if provider == google_flights.PROVIDER:
        return await google_flights.fetch_calendar(client, query)
    raise FareError("unknown-provider", f"No fare provider named {provider!r}", route=query.route)


#: How wide a window one calendar request may ask for, from whichever provider
#: is wired. The caller splits the booking horizon by this and does not learn
#: whose limit it is — decision 8.3 applies to a number as much as to a name.
CALENDAR_RANGE_DAYS = google_flights.CALENDAR_RANGE_DAYS


__all__ = [
    "CALENDAR_RANGE_DAYS",
    "DEFAULT_PROVIDER",
    "PROVIDERS",
    "CalendarPrice",
    "CalendarQuery",
    "FareError",
    "FareOffer",
    "FareQuery",
    "SearchResult",
    "fetch_calendar",
    "fetch_offers",
    "fetch_search",
    "normalize_code",
]
