"""
Do the fare providers still answer, and do they still mean the same thing?

Two providers, two different questions to ask them.

`google-flights` reads an untagged array by position. When Google renumbers it,
the adapter does not throw at the network — it fetches a perfectly good page and
finds nothing in it. `parse_payload` turns that into a `parse-drift` error on
purpose, and this script is what asks the question on a schedule a human keeps.

`travelpayouts` is a documented JSON API, so drift there is rarer. What is worth
checking is that the token still works, that Lima routes still return anything
at all, and above all that its departure times still arrive with a zone offset
that we are still stripping. If an offset ever reached the archive, two rows
would mean different things while looking identical.

    npm run fares:check

**Manual only, and deliberately so** — the same reasoning as
`.github/workflows/upstream-reachability.yml`. This reaches third parties on
purpose, and from a datacenter address Google answers with a consent wall rather
than a page, so a CI run would report a failure about GitHub's IP and teach us
nothing about the parser.

The unit tests pin both parsers against captured payloads, which catches *us*
breaking them. Only a live request catches *them* breaking, and for Google only
from an address like the one the collector runs from.
"""

import argparse
import asyncio
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

import httpx  # noqa: E402

from app.adapters.fares import google_flights, travelpayouts  # noqa: E402
from app.adapters.fares.models import FareError, FareOffer, FareQuery  # noqa: E402
from app.config import UPSTREAM_TIMEOUT_SECONDS, travelpayouts_token  # noqa: E402

# Windows consoles default to cp1252, which cannot encode an arrow or an
# accented airline name — and a scheduled task that dies on its own summary
# line looks exactly like a collection that failed. Measured: the first real
# pass crashed here.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

# Busy routes out of Lima, chosen so a blank answer means the parser rather
# than the route: domestic, regional, and long haul all serve these daily.
ROUTES = (("LIM", "CUZ"), ("LIM", "SCL"), ("LIM", "MAD"))

# Far enough out that fares exist and near enough that the schedule is loaded.
DAYS_AHEAD = 60

# The collector's own pacing. A check that hammers is a check that causes the
# block it is looking for.
GAP_SECONDS = 6


def describe(offer: FareOffer) -> str:
    return (
        f"{offer.currency} {offer.price:.2f} on {offer.airline_name or offer.airline} "
        f"at {offer.departure_at.split('T')[1]}"
    )


def complaints(offers: list[FareOffer]) -> list[str]:
    """
    What is wrong with a batch that still parsed.

    A page that parses but yields something unusable is the failure this script
    exists for, and none of it is an exception.
    """
    found = []
    cheapest = min(offers, key=lambda offer: offer.price)
    if not cheapest.airline or not cheapest.departure_at:
        found.append("offer is missing airline or departure time")
    # The contract is wall clock with no zone (decision 12.7). A provider that
    # starts sending one, or an adapter that stops stripping it, moves every
    # midnight departure to the wrong day for anyone who formats it.
    leaked = [
        offer.departure_at for offer in offers if offer.departure_at[10:].strip("T0123456789:")
    ]
    if leaked:
        found.append(f"departure time carries a zone: {leaked[0]}")
    return found


async def check_provider(client, name: str, fetch, flight_date: str, *, partial: bool) -> int:
    """
    Ask one provider about every route, and count what is actually wrong.

    `partial` says this provider is known not to cover everything. Measured
    2026-08-18: Travelpayouts had no cached price for LIM-MAD on a named date
    while answering for the month, because it is a cache of other people's
    searches rather than a search engine. A route it does not know is a fact
    about its cache, not a broken adapter, so it is printed and not counted —
    a check that is red every single day is a check nobody reads.

    Answering *nothing at all* is still a failure, partial or not.
    """
    print(f"\n{name}")
    failures = 0
    answered = 0
    for index, (origin, destination) in enumerate(ROUTES):
        if index:
            await asyncio.sleep(GAP_SECONDS)
        try:
            offers = await fetch(client, FareQuery(origin, destination, flight_date))
        except FareError as error:
            forgiven = partial and error.code == "no-offers"
            if not forgiven:
                failures += 1
            print(
                f"  {'none ' if forgiven else 'FAIL '} {origin}->{destination}  "
                f"{error.code}: {error.message}"
            )
            continue

        answered += 1
        cheapest = min(offers, key=lambda offer: offer.price)
        print(
            f"  ok    {origin}->{destination}  {len(offers):>3} offers  "
            f"cheapest {describe(cheapest)}"
        )
        for complaint in complaints(offers):
            failures += 1
            print(f"        ! {complaint}")

    if not answered:
        failures += 1
        print("        ! this provider answered nothing at all")
    return failures


async def check(days_ahead: int) -> int:
    flight_date = (datetime.now(UTC) + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
    print(f"asking both providers about {flight_date}")
    failures = 0

    async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS) as client:
        failures += await check_provider(
            client,
            google_flights.PROVIDER,
            google_flights.fetch_offers,
            flight_date,
            partial=False,
        )
        if travelpayouts_token():
            failures += await check_provider(
                client,
                travelpayouts.PROVIDER,
                travelpayouts.fetch_offers,
                flight_date,
                partial=True,
            )
        else:
            # Not a failure. The fallback is optional configuration, and saying
            # so is more useful than a red line about a knob nobody turned.
            print(f"\n{travelpayouts.PROVIDER}\n  skipped: TRAVELPAYOUTS_TOKEN is not set")

    print(f"\n{failures} problem(s)")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days-ahead", type=int, default=DAYS_AHEAD)
    args = parser.parse_args()
    return 1 if asyncio.run(check(args.days_ahead)) else 0


if __name__ == "__main__":
    raise SystemExit(main())
