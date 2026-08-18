"""
One collection pass over the watched routes, from the command line.

This is the thing Task Scheduler runs. It imports the collector directly rather
than calling the API over HTTP, so a scheduled pass does not need a server to
be up — the price of a route on a given day exists for a day, and missing it
because uvicorn was not running would lose it for good.

    npm run fares:collect
    npm run fares:collect -- --dry-run

**Run it from a residential connection.** The upstream is Google Flights, which
fingerprints datacenter addresses; the plan's runner decision is "local now,
GCP later" precisely because a Cloud Run job would meet a consent wall. Moving
this to a scheduler in the cloud means changing the provider first, not just
the host.

To schedule it on Windows, once:

    schtasks /create /tn "Edicius airfare" /tr ^
      "cmd /c cd /d D:\\Work\\research\\edicius-hq && npm run fares:collect" ^
      /sc daily /st 07:00

One pass a day is the design. The archive keys observations by the day they
were taken, so collecting twice puts two points on one date and flatters the
series with detail it does not have.
"""

import argparse
import asyncio
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.adapters.fares.models import FareQuery  # noqa: E402
from app.config import kv_dir  # noqa: E402
from app.services.fare_collector import collect  # noqa: E402
from app.services.fare_history import HISTORY  # noqa: E402

# Windows consoles default to cp1252, which cannot encode an arrow or an
# accented airline name — and a scheduled task that dies on its own summary
# line looks exactly like a collection that failed. Measured: the first real
# pass crashed here.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROUTES_KEY = "airfare-routes"


def today() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%d")


def load_routes() -> list[dict[str, object]]:
    """
    The watchlist, read straight off disk.

    The KV document is written by the browser through the API; here we only
    read it, so there is no allowlist to consult and no server to ask.
    """
    path = kv_dir() / f"{ROUTES_KEY}.json"
    if not path.exists():
        return []
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except ValueError as error:
        print(f"! {path} is not readable JSON: {error}", file=sys.stderr)
        return []
    routes = document.get("routes") if isinstance(document, dict) else None
    return [route for route in routes or [] if isinstance(route, dict)]


def to_queries(routes: list[dict[str, object]], on: str) -> list[FareQuery]:
    """
    Skip departures that have already left.

    Asking about one returns nothing every day forever, and a failure that can
    never resolve is noise in a report whose whole job is to be worth reading.
    """
    queries = []
    for route in routes:
        flight_date = str(route.get("flightDate", ""))
        if flight_date < on:
            continue
        return_date = route.get("returnDate")
        queries.append(
            FareQuery(
                origin=str(route.get("origin", "")).upper(),
                destination=str(route.get("destination", "")).upper(),
                flight_date=flight_date,
                return_date=str(return_date) if return_date else None,
                currency=str(route.get("currency", "USD")).upper(),
            )
        )
    return queries


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what would be collected and reach nothing.",
    )
    parser.add_argument(
        "--gap",
        type=float,
        default=None,
        help="Seconds between upstream requests. Lower it only for a test.",
    )
    args = parser.parse_args()

    on = today()
    routes = load_routes()
    queries = to_queries(routes, on)

    skipped = len(routes) - len(queries)
    print(f"watchlist: {len(routes)} route(s), {len(queries)} to collect, {skipped} departed")
    if not queries:
        print("nothing to do")
        return 0

    for query in queries:
        print(f"  {query.origin} -> {query.destination}  departs {query.flight_date}")

    if args.dry_run:
        print("dry run; nothing was fetched")
        return 0

    kwargs = {} if args.gap is None else {"gap_seconds": args.gap}
    report = asyncio.run(collect(queries, **kwargs))

    print()
    for result in report.results:
        if result.ok:
            price = f"{result.currency} {result.cheapest:.2f}" if result.cheapest else "no price"
            print(f"  ok    {result.route} {result.flight_date}  {result.offers} offers, {price}")
        else:
            print(
                f"  FAIL  {result.route} {result.flight_date}  "
                f"{result.error_code}: {result.error_message}"
            )

    print(f"\n{report.collected} collected, {report.failed} failed → {HISTORY.directory}")
    # A non-zero exit is what makes a silent scheduled task visible: Task
    # Scheduler records the code, so a week of drift shows up in its history
    # rather than only in a chart nobody opened.
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
