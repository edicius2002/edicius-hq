"""
Does the Google Flights adapter still understand Google Flights?

The scraper reads an untagged array by position. When Google renumbers it, the
adapter does not throw at the network — it fetches a perfectly good page and
finds nothing in it. `parse_payload` turns that into a `parse-drift` error on
purpose, and this script is what asks the question on a schedule a human keeps.

    npm run fares:check

**Manual only, and deliberately so** — the same reasoning as
`.github/workflows/upstream-reachability.yml`. This reaches a third party on
purpose, and from a datacenter address it would be answered with a consent wall
rather than a page, so a CI run would report a failure about GitHub's IP and
teach us nothing about the parser.

The unit tests pin the parser against a captured fixture, which catches *us*
breaking it. Only a live request catches *Google* breaking it, and only from an
address like the one the collector runs from.
"""

import argparse
import asyncio
import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

import httpx  # noqa: E402

from app.adapters.fares.google_flights import fetch_offers  # noqa: E402
from app.adapters.fares.models import FareError, FareQuery  # noqa: E402
from app.config import UPSTREAM_TIMEOUT_SECONDS  # noqa: E402

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


async def check(routes: tuple[tuple[str, str], ...], days_ahead: int) -> int:
    flight_date = (datetime.now(UTC) + timedelta(days=days_ahead)).strftime("%Y-%m-%d")
    failures = 0

    async with httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS) as client:
        for index, (origin, destination) in enumerate(routes):
            if index:
                # The collector's own pacing. A check that hammers is a check
                # that causes the block it is looking for.
                await asyncio.sleep(6)

            query = FareQuery(origin, destination, flight_date)
            try:
                offers = await fetch_offers(client, query)
            except FareError as error:
                failures += 1
                print(f"FAIL  {origin}->{destination}  {error.code}: {error.message}")
                continue

            cheapest = min(offers, key=lambda offer: offer.price)
            print(
                f"ok    {origin}->{destination}  {len(offers):>3} offers  "
                f"cheapest {cheapest.currency} {cheapest.price:.2f} on "
                f"{cheapest.airline_name or cheapest.airline} "
                f"at {cheapest.departure_at.split('T')[1]}"
            )

            # A page that parses but yields nothing usable is the failure this
            # script exists for, and it is not an exception.
            if not cheapest.airline or not cheapest.departure_at:
                failures += 1
                print("      ! offer is missing airline or departure time")

    print(f"\n{len(routes) - failures}/{len(routes)} routes readable for {flight_date}")
    return failures


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days-ahead", type=int, default=DAYS_AHEAD)
    args = parser.parse_args()
    return 1 if asyncio.run(check(ROUTES, args.days_ahead)) else 0


if __name__ == "__main__":
    raise SystemExit(main())
