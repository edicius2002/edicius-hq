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

import httpx

from app.adapters.fares import google_flights
from app.adapters.fares.models import FareError, FareOffer, FareQuery, SearchResult

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
        return await google_flights.fetch_search(client, query)
    raise FareError("unknown-provider", f"No fare provider named {provider!r}", route=query.route)


async def fetch_offers(
    client: httpx.AsyncClient,
    query: FareQuery,
    *,
    provider: str = DEFAULT_PROVIDER,
) -> list[FareOffer]:
    if provider == google_flights.PROVIDER:
        return await google_flights.fetch_offers(client, query)
    raise FareError("unknown-provider", f"No fare provider named {provider!r}", route=query.route)


__all__ = [
    "DEFAULT_PROVIDER",
    "PROVIDERS",
    "FareError",
    "FareOffer",
    "FareQuery",
    "fetch_offers",
    "fetch_search",
    "normalize_code",
]
