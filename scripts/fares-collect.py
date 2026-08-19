"""
One collection pass over the watched routes, from the command line.

This is the thing the scheduler runs. It imports the collector directly rather
than calling the API over HTTP, so a pass does not need a server to be up — a
price on a given day exists for a day, and missing it because uvicorn was not
running would lose it for good.

    npm run fares:collect
    npm run fares:collect -- --dry-run
    npm run fares:collect -- --all          # ignore the cadence, poll everything

**A watched route is a city pair and a month** — 12.110 — so a pass expands
each month into its departures and schedules every one of them separately.
Thirty-one days spread over thirty-one distances get thirty-one intervals: the
near end of a month can be on the half-hourly rate while the far end is still
daily.

**It is safe to run often, and meant to be.** The pass decides for itself what
is due: each departure has a poll interval that depends on how far away it is,
and one that is not due yet is reported as skipped rather than fetched. Running
this every fifteen minutes does not mean fifteen-minute traffic — it means the
near departures get looked at every half hour and a departure five months out
gets looked at once a day. Measured 2026-08-18: a fare 14 days out moved on 27%
of days by a median 14%, while one 150 days out moved on 22% of days by 1.7%.

`--dry-run` prints what a month costs per day under that cadence, which is the
number to look at before adding one: a month whose first day is a week away
costs 936 requests a day against a budget of 300, and the same month at 200
days out costs 31.

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
from collections import Counter
from datetime import UTC, date, datetime
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.config import MAX_DEPARTURE_HORIZON_DAYS, daily_request_budget, kv_dir  # noqa: E402
from app.services.fare_collector import FareWatch, collect, collect_due, expand  # noqa: E402
from app.services.fare_history import HISTORY  # noqa: E402
from app.services.fare_schedule import days_until, month_dates, poll_minutes  # noqa: E402

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


def to_watches(routes: list[dict[str, object]]) -> tuple[list[FareWatch], list[str]]:
    """
    Watched months worth asking about, and the ones that are not.

    Only whole months are dropped here — one nobody can read, and one the
    calendar has finished with, which returns nothing every day forever. The
    days *inside* a month are not judged at this level: a month can be half
    departed and half collectable, and deciding one day at a time is
    `collect_due`'s job because it is the side that reports what it skipped.

    The document may still carry the pre-12.110 `flightDate` shape if the
    browser has not rewritten it yet, and the month that date falls in is
    stated by the value rather than guessed — same repair the web normalizer
    makes, for the same reason.
    """
    today = datetime.now(UTC).date()
    this_month = today.strftime("%Y-%m")
    watches: list[FareWatch] = []
    dropped: list[str] = []
    for route in routes:
        origin = str(route.get("origin", "")).upper()
        destination = str(route.get("destination", "")).upper()
        stored = route.get("month")
        legacy = str(route.get("flightDate", ""))
        # Same rule as the web normalizer, deliberately: a month is repaired
        # out of a departure date only when that date is a real one.
        # `2026-02-31` is a typo, so it is not evidence of February either —
        # two sides reading one document must not disagree about which entries
        # survive it.
        repaired = legacy[:7] if days_until(legacy, today) is not None else legacy
        month = str(stored) if stored else repaired
        label = f"{origin}-{destination} {month}"

        if not month_dates(month):
            dropped.append(f"{label}: unreadable month")
            continue
        if month < this_month:
            dropped.append(f"{label}: the month is over")
            continue

        # The focused departure, if the reader named one (12.130). Kept only
        # when it is inside its own month, the same rule the web normalizer
        # applies on read — the two sides must not disagree about which watches
        # survive a document. A focus that has already departed is *not*
        # dropped here: the collector reports it as `departed` by name, which
        # is more use to a reader than its silent disappearance.
        focus = route.get("focusDate")
        focus = str(focus) if isinstance(focus, str) and focus[:7] == month else None

        watches.append(
            FareWatch(
                origin=origin,
                destination=destination,
                month=month,
                currency=str(route.get("currency", "USD")).upper(),
                focus=focus,
            )
        )
    return watches, dropped


def per_day(watch: FareWatch, today: date) -> tuple[int, int]:
    """
    How many departures in this month are collectable, and what they cost a day.

    The second number is the one worth reading before adding a month: it is the
    sum over its days of `1440 / poll_minutes(days_out)`, which is the traffic
    this one watch will generate every day until it departs. It climbs steeply
    as the month approaches, because the cadence table does.
    """
    collectable = requests = 0
    for flight_date in month_dates(watch.month):
        days_out = days_until(flight_date, today)
        if days_out is None or days_out < 0 or days_out > MAX_DEPARTURE_HORIZON_DAYS:
            continue
        collectable += 1
        requests += 24 * 60 // poll_minutes(days_out)
    return collectable, requests


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
        help=(
            "Ignore the cadence and poll every departure in every watched "
            "month. One month is up to 31 requests and three minutes of pacing."
        ),
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
    watches, dropped = to_watches(routes)

    print(f"watchlist: {len(routes)} route(s), {len(watches)} watchable, {len(dropped)} dropped")
    for reason in dropped:
        print(f"  -- {reason}")

    budget = daily_request_budget()
    demand = 0
    for watch in watches:
        collectable, requests = per_day(watch, today)
        demand += requests
        # The focus is printed beside the demand rather than in a line of its
        # own: it is the day this month keeps when the sum below reads OVER,
        # and the two numbers only mean anything read together.
        starred = f"  focus {watch.focus}" if watch.focus else ""
        print(
            f"  {watch.origin} -> {watch.destination}  departs in {watch.month}  "
            f"({collectable} of {len(month_dates(watch.month))} day(s) collectable, "
            f"{requests} request(s)/day){starred}"
        )
    if not watches:
        print("nothing to do")
        return 0

    # The cadence is what makes a month affordable, so the arithmetic is
    # printed rather than trusted. Over budget is not an error here: the pass
    # keeps the focused departures and then the nearest ones, and reports the
    # rest as `over-budget` — which is the honest shape of "you are watching
    # more than 300 a day of". The current watchlist is 62 a day; the same two
    # months come to 302 on 2026-11-24 and 2,208 by the March they depart in,
    # which is when the focus starts deciding something.
    fit = "fits" if demand <= budget else "OVER"
    print(f"\ncadence demand: {demand} request(s)/day against a budget of {budget} -- {fit}")

    if args.dry_run:
        print("dry run; nothing was fetched")
        return 0

    kwargs = {} if args.gap is None else {"gap_seconds": args.gap}
    if args.all:
        queries, unreadable = expand(watches)
        for what in unreadable:
            print(f"  -- {what}: unreadable month")
        report = asyncio.run(collect(list(queries.values()), **kwargs))
    else:
        report = asyncio.run(collect_due(watches, **kwargs))

    print()
    # Grouped rather than listed. A month expands to thirty-one departures and
    # a healthy daily pass skips thirty of them, so printing one line each
    # would bury the results under the routine — while a count per reason still
    # says everything 8.8 asks for, which is what was skipped and why.
    for reason, count in sorted(Counter(reason for _, reason in report.skipped).items()):
        print(f"  --    {count} departure(s)  {reason}")
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
        f"{report.failed} failed, {len(report.skipped)} skipped -> {HISTORY.directory}"
    )
    # A non-zero exit is what makes a silent scheduled task visible: Task
    # Scheduler records the code, so a week of drift shows up in its history
    # rather than only in a chart nobody opened.
    return 1 if report.failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
