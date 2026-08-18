"""
One collection pass over the watched routes, from the command line.

This is the thing the scheduler runs. It imports the collector directly rather
than calling the API over HTTP, so a pass does not need a server to be up — a
price on a given day exists for a day, and missing it because uvicorn was not
running would lose it for good.

    npm run fares:collect
    npm run fares:collect -- --dry-run
    npm run fares:collect -- --all          # ignore the cadence, poll everything

**It is safe to run often, and meant to be.** The pass decides for itself what
is due: each departure has a poll interval that depends on how far away it is,
and one that is not due yet is reported as skipped rather than fetched. Running
this every fifteen minutes does not mean fifteen-minute traffic — it means the
near departures get looked at every half hour and a departure five months out
gets looked at once a day. Measured 2026-08-18: a fare 14 days out moved on 27%
of days by a median 14%, while one 150 days out moved on 22% of days by 1.7%.

    schtasks /create /tn "Edicius airfare" /tr ^
      "cmd /c cd /d D:\\Work\\research\\edicius-hq && npm run fares:collect" ^
      /sc minute /mo 15

**Run it from a residential connection.** The upstream is Google Flights, which
fingerprints datacenter addresses; the plan's runner decision is "local now,
GCP later" precisely because a Cloud Run job would meet a consent wall.

The day's request budget is the one ceiling that is a judgement rather than a
measurement — the endpoint is unmetered, and the real limit is how much traffic
one address can send before it stops being answered. `FARES_DAILY_REQUEST_BUDGET`
sets it; the default is 300.
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
from app.config import MAX_DEPARTURE_HORIZON_DAYS, daily_request_budget, kv_dir  # noqa: E402
from app.services.fare_collector import collect, collect_due  # noqa: E402
from app.services.fare_history import HISTORY  # noqa: E402
from app.services.fare_schedule import days_until, poll_minutes  # noqa: E402

# Windows consoles default to cp1252, which cannot encode an arrow or an
# accented airline name — and a scheduled task that dies on its own summary
# line looks exactly like a collection that failed. Measured: the first real
# pass crashed here.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

ROUTES_KEY = "airfare-routes"


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


def to_queries(routes: list[dict[str, object]]) -> tuple[list[FareQuery], list[str]]:
    """
    Watched departures worth asking about, and the ones that are not.

    A departure that has left returns nothing every day forever, and one past
    the horizon Google will answer for — measured at 330 days — never collects
    at all. Both are dropped here with a reason rather than becoming a daily
    failure line that nobody can act on.
    """
    today = datetime.now(UTC).date()
    queries: list[FareQuery] = []
    dropped: list[str] = []
    for route in routes:
        flight_date = str(route.get("flightDate", ""))
        origin = str(route.get("origin", "")).upper()
        destination = str(route.get("destination", "")).upper()
        label = f"{origin}-{destination} {flight_date}"

        days_out = days_until(flight_date, today)
        if days_out is None:
            dropped.append(f"{label}: unreadable date")
            continue
        if days_out < 0:
            dropped.append(f"{label}: departed")
            continue
        if days_out > MAX_DEPARTURE_HORIZON_DAYS:
            dropped.append(
                f"{label}: {days_out}d out, past the {MAX_DEPARTURE_HORIZON_DAYS}d horizon"
            )
            continue

        return_date = route.get("returnDate")
        queries.append(
            FareQuery(
                origin=origin,
                destination=destination,
                flight_date=flight_date,
                return_date=str(return_date) if return_date else None,
                currency=str(route.get("currency", "USD")).upper(),
            )
        )
    return queries, dropped


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="List what is due and reach nothing.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Ignore the cadence and poll every watched departure.",
    )
    parser.add_argument(
        "--gap",
        type=float,
        default=None,
        help="Seconds between upstream requests. Lower it only for a test.",
    )
    args = parser.parse_args()

    today = datetime.now(UTC).date()
    routes = load_routes()
    queries, dropped = to_queries(routes)

    print(f"watchlist: {len(routes)} route(s), {len(queries)} watchable, {len(dropped)} dropped")
    for reason in dropped:
        print(f"  -- {reason}")
    for query in queries:
        days_out = days_until(query.flight_date, today) or 0
        print(
            f"  {query.origin} -> {query.destination}  departs {query.flight_date}  "
            f"({days_out}d out, every {poll_minutes(days_out)} min)"
        )
    if not queries:
        print("nothing to do")
        return 0

    if args.dry_run:
        print(f"dry run; budget is {daily_request_budget()} request(s)/day")
        return 0

    kwargs = {} if args.gap is None else {"gap_seconds": args.gap}
    if args.all:
        report = asyncio.run(collect(queries, **kwargs))
    else:
        report = asyncio.run(collect_due(queries, **kwargs))

    print()
    for what, reason in report.skipped:
        print(f"  --    {what}  {reason}")
    for result in report.results:
        if result.ok:
            price = f"{result.currency} {result.cheapest:.2f}" if result.cheapest else "no price"
            mark = "CHANGED" if result.changed else "same   "
            seeded = f"  +{result.seeded}d seeded" if result.seeded else ""
            print(
                f"  {mark} {result.route} {result.flight_date}  "
                f"{result.offers} offers, {price}{seeded}"
            )
        else:
            print(
                f"  FAIL    {result.route} {result.flight_date}  "
                f"{result.error_code}: {result.error_message}"
            )

    print(
        f"\n{len(report.results)} looked at, {report.changed} changed, "
        f"{report.failed} failed, {len(report.skipped)} not due -> {HISTORY.directory}"
    )
    # A non-zero exit is what makes a silent scheduled task visible: Task
    # Scheduler records the code, so a week of drift shows up in its history
    # rather than only in a chart nobody opened.
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
