"""
Which provider answers a fare query.

The same indirection `app.adapters.registry` provides for market data, and for
the same reason — decision 8.3. A caller asks for LIM-SCL and gets offers
without learning who answered, so swapping providers is a change here and
nowhere else.

Two providers are wired, and they are not interchangeable. `google_flights`
reads live itineraries with airline and departure time, and is a scraper of an
undocumented payload. `travelpayouts` is documented and stable and answers a
narrower question: one cached cheapest offer per date, measured days old. The
first is the workhorse; the second exists so a day the scraper cannot read is a
worse observation rather than no observation, which in this archive is the only
kind of loss that cannot be undone.

Because they answer differently, whoever answered travels with the result. A
caller that stamps a snapshot with the wrong provider makes a cached
cheapest-of-the-day indistinguishable from a live itinerary list, which is the
one thing this feature must never do quietly.
"""

import logging

import httpx

from app.adapters.fares import google_flights, travelpayouts
from app.adapters.fares.models import FareError, FareOffer, FareQuery

logger = logging.getLogger(__name__)

DEFAULT_PROVIDER = google_flights.PROVIDER

FALLBACK_PROVIDER = travelpayouts.PROVIDER

PROVIDERS = (google_flights.PROVIDER, travelpayouts.PROVIDER)

# Codes that mean the provider understood the question and the answer is "no
# flights". Reaching for a second provider here would replace a fact with a
# cached guess — and on a route that genuinely has no service that day, it
# would do it every single day.
ANSWERED_CODES = frozenset({"no-offers"})


def normalize_code(code: str) -> str:
    return code.strip().upper()


async def fetch_offers(
    client: httpx.AsyncClient,
    query: FareQuery,
    *,
    provider: str = DEFAULT_PROVIDER,
) -> list[FareOffer]:
    if provider == google_flights.PROVIDER:
        return await google_flights.fetch_offers(client, query)
    if provider == travelpayouts.PROVIDER:
        return await travelpayouts.fetch_offers(client, query)
    raise FareError("unknown-provider", f"No fare provider named {provider!r}", route=query.route)


async def fetch_with_fallback(
    client: httpx.AsyncClient,
    query: FareQuery,
    *,
    provider: str = DEFAULT_PROVIDER,
    fallback: str | None = FALLBACK_PROVIDER,
) -> tuple[str, list[FareOffer]]:
    """
    Offers and the name of whoever actually produced them.

    The fallback is tried when the primary could not answer — it was blocked,
    unreachable, or stopped understanding the page. It is *not* tried when the
    primary answered "no flights that day", because that is an answer.

    If the fallback also fails, the primary's error is what propagates. It is
    the one the operator can act on; "TRAVELPAYOUTS_TOKEN is not set" would be
    a true statement about the wrong problem.
    """
    try:
        return provider, await fetch_offers(client, query, provider=provider)
    except FareError as error:
        if not fallback or fallback == provider or error.code in ANSWERED_CODES:
            raise
        primary_error = error

    try:
        offers = await fetch_offers(client, query, provider=fallback)
    except FareError as second:
        logger.warning(
            "both fare providers refused %s: %s said %s, %s said %s",
            query.route,
            provider,
            primary_error.code,
            fallback,
            second.code,
        )
        raise primary_error from second

    logger.info(
        "%s could not answer %s (%s); fell back to %s",
        provider,
        query.route,
        primary_error.code,
        fallback,
    )
    return fallback, offers


__all__ = [
    "ANSWERED_CODES",
    "DEFAULT_PROVIDER",
    "FALLBACK_PROVIDER",
    "PROVIDERS",
    "FareError",
    "FareOffer",
    "FareQuery",
    "fetch_offers",
    "fetch_with_fallback",
    "normalize_code",
]
