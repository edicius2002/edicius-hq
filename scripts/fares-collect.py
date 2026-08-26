"""
One collection pass over the watched routes, from the command line.

This is the thing the scheduler runs. It imports the collector directly rather
than calling the API over HTTP, so a pass does not need a server to be up — a
price on a given day exists for a day, and missing it because uvicorn was not
running would lose it for good.

    npm run fares:collect
    npm run fares:collect -- --dry-run
    npm run fares:collect -- --all          # ignore the cadence, poll everything

**A watched route is a city pair and one or more months** — 12.110, widened by
`a-watch-is-a-pair-and-its-months` — so a pass expands each month into its
departures and schedules every one of them separately. Thirty-one days spread
over thirty-one distances get thirty-one intervals: the near end of a month can
be on the half-hourly rate while the far end is still daily.

The stored document is read in whichever of three shapes it was last written
in, and `stored_months` holds all of that reading. This file has already broken
silently once — for days — by assuming the shape it expected, so the shape it
reads is covered end to end by a subprocess test rather than by inspection.

**Every other month is collected too, and far more cheaply.** A watched month
gets a full board per departure; every remaining month out to the 330-day
horizon gets one cheapest fare per departure date, from Google's own price
graph. That is 2.43 requests per city pair per day for the whole year, measured
rather than planned — two windows, plus the walk-back when the far end is
refused — against thirty for one month of boards, and it is what stops the
eleven months nobody watched from being dark. It carries one number a day and
nothing else — no carrier, no times, no itineraries — so it does not replace a
board. Those requests are written to the same daily ledger as the boards, which
they were not until now — one address, one day, one count.

**It is safe to run often, and meant to be.** The pass decides for itself what
is due: each departure has a poll interval that depends on how far away it is,
and one that is not due yet is reported as skipped rather than fetched. Running
this every fifteen minutes does not mean fifteen-minute traffic — it means the
near departures get looked at every half hour and a departure five months out
gets looked at once a day. Measured 2026-08-18: a fare 14 days out moved on 27%
of days by a median 14%, while one 150 days out moved on 22% of days by 1.7%.

`--dry-run` prints what a month costs per day under that cadence, which is the
number to look at before adding one: a month whose first day is a week away
costs 936 requests a day, and the same month at 200 days out costs 31. It also
prints what the day has spent so far, which is a different question — the first
is a property of the watchlist and the second of the day.

    schtasks /create /tn "Edicius airfare" /tr ^
      "cmd /c cd /d D:\\Work\\research\\edicius-hq && npm run fares:collect" ^
      /sc minute /mo 15

**It is also safe to run while another pass is running**, which is the case the
line above creates: a task firing every fifteen minutes will sooner or later fire
while the owner has pressed Collect in the browser, and the browser's pass is a
different process from this one. One board pass and one calendar pass collect
from this address at a time — two locks, because those are two slots on purpose.
The second one of either kind to arrive takes nothing, sends nothing, and reports
every departure or pair as `another-pass-is-running` in the same list
`over-budget` appears in; it exits 0, because being second is not a failure. A
pass whose process is killed leaves its lock behind and the next pass clears it
once nothing has touched it for five minutes.

**Run it from a residential connection.** The upstream is Google Flights, which
fingerprints datacenter addresses; the plan's runner decision is "local now,
GCP later" precisely because a Cloud Run job would meet a consent wall.

**There is no daily request ceiling by default, and that is deliberate.** The
endpoint is unmetered, and the real limit is how much traffic one address can
send before it stops being answered — a number nobody has measured and which
cannot be probed without spending the thing it protects. A count picked in place
of it stopped a collector on 2026-08-22 for a reason no upstream had given, so
what bounds a pass is the pace it sends at and the one-pass-at-a-time lock
rather than a total. `FARES_DAILY_REQUEST_BUDGET` takes a number and puts the
whole ceiling back — `over-budget` by name, nearest departures kept (12.111) —
for an environment that wants one; `0`, `off` or `none` say the default out loud.

**What is kept either way is the ledger**, in `.local-data/fares/spend/<day>.jsonl`,
one line per request actually sent. It is on disk rather than in this process,
so a pass that starts fresh every fifteen minutes still knows what the fourteen
before it sent, and `--dry-run` and the page in the browser both read it back.
That is the record a future ceiling would have to be sized against, and the
reason this half was not removed with the other.

**And this invocation leaves a line of its own**, in
`.local-data/fares/passes/<day>.jsonl` — one per pass, *including the passes that
send nothing*, which is 99 firings out of every 105. Until it existed a no-op
pass wrote nothing anywhere, so a day of ninety-six firings and a day of two
looked identical on disk and neither the fifteen-minute interval nor the paced
gap could be checked against what actually happened. The line carries the pace
(`gap`), what the pass did and skipped, and **how long it took** (`wallMs`) —
that last one because the scheduled task above is `MultipleInstances = IgnoreNew`,
so a pass that runs past its own interval makes the next firing disappear without
a word. `--dry-run` writes no line: it reaches nothing, so it records nothing.
"""

import argparse
import asyncio
import json
import sys
from collections import Counter
from datetime import UTC, date, datetime
from math import ceil
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.config import (  # noqa: E402
    CALENDAR_REQUESTS_PER_PAIR,
    MAX_DEPARTURE_HORIZON_DAYS,
    SCHEDULER_INTERVAL_MINUTES,
    daily_request_budget,
    kv_dir,
)
from app.services.fare_budget import daily_budget  # noqa: E402
from app.services.fare_collector import (  # noqa: E402
    REQUEST_GAP_SECONDS,
    FareWatch,
    calendar_windows,
    collect,
    collect_calendars,
    collect_due,
    expand,
)
from app.services.fare_history import HISTORY  # noqa: E402
from app.services.fare_passes import PassRecorder  # noqa: E402
from app.services.fare_schedule import days_until, month_dates, poll_minutes  # noqa: E402

# Windows consoles default to cp1252, which cannot encode an arrow or an
# accented airline name — and a scheduled task that dies on its own summary
# line looks exactly like a collection that failed. Measured: the first real
# pass crashed here.
#
# The suppression is the stub's shape and not a doubt about the call:
# `sys.stdout` is typed `TextIO`, which has no `reconfigure`, while the
# object actually standing there is a `TextIOWrapper`, which does.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]
sys.stderr.reconfigure(encoding="utf-8", errors="replace")  # type: ignore[union-attr]

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


def stored_months(route: dict[str, object], today: date) -> list[str]:
    """
    Every departure month one stored entry names, in the order it names them.

    **Three shapes are read and all three will keep being read.** This file and
    the browser read the same document, the browser is the only writer, and it
    rewrites lazily — `normalizeFareRoutes` takes no clock and edits nothing on
    load (12.133), so an entry keeps whatever shape it was last saved in until
    the reader next adds, removes, reorders or edits a route. That may be months
    away and there is no upgrade step that will end it, so what follows is the
    reader, not a migration shim with a removal date.

    - ``months: ["2027-03", "2027-04"]`` — what the browser writes now.
    - ``month: "2027-03"`` — 12.110's shape, one entry per pair and month. The
      owner's stored document held ``AEP-SCL`` twice in it.
    - ``flightDate: "2027-03-09"`` — pre-12.110, repaired to the month that date
      falls in, and only when the date is a real one. ``2026-02-31`` is a typo,
      so it is not evidence of February either; two sides reading one document
      must not disagree about which entries survive it.

    Values that are not months come back unrepaired rather than dropped here, so
    the caller can name them in its own report. A month that vanishes between a
    watchlist and a summary is the silence 8.8 and 8.41 exist to stop.

    This function is why the file broke silently once before and must not again.
    A ``months`` array read by the old singular ``route.get("month")`` is a
    truthy list whose ``str()`` is ``"['2027-03', '2027-04']"``, which
    ``month_dates`` refuses — so every route would have been dropped as an
    unreadable month and the whole watchlist would have stopped collecting with
    a clean exit code, every fifteen minutes, saying nothing.
    """
    listed = route.get("months")
    if isinstance(listed, list):
        return [str(month) for month in listed]

    stored = route.get("month")
    if stored:
        return [str(stored)]

    legacy = str(route.get("flightDate", ""))
    if not legacy:
        return []
    # Same rule as the web normalizer, deliberately: a month is repaired out of
    # a departure date only when that date is a real one.
    return [legacy[:7] if days_until(legacy, today) is not None else legacy]


def to_watches(routes: list[dict[str, object]]) -> tuple[list[FareWatch], list[str]]:
    """
    Watched months worth asking about, and the ones that are not.

    Only whole months are dropped here — one nobody can read, and one the
    calendar has finished with, which returns nothing every day forever. The
    days *inside* a month are not judged at this level: a month can be half
    departed and half collectable, and deciding one day at a time is
    `collect_due`'s job because it is the side that reports what it skipped.

    The document may carry any of three shapes — see `stored_months`, which is
    where all the reading of them happens — and one entry may name several
    months. **The unit of judgement here is the month, not the entry**: a route
    naming twelve months with a typo in one keeps the other eleven, because
    dropping the entry would cost a reader eleven watches for one bad chip.
    """
    today = datetime.now(UTC).date()
    this_month = today.strftime("%Y-%m")
    watches: list[FareWatch] = []
    dropped: list[str] = []
    seen: set[FareWatch] = set()
    for route in routes:
        origin = str(route.get("origin", "")).upper()
        destination = str(route.get("destination", "")).upper()
        currency = str(route.get("currency", "USD")).upper()

        months = stored_months(route, today)
        if not months:
            dropped.append(f"{origin}-{destination}: no departure month")
            continue

        for month in months:
            label = f"{origin}-{destination} {month}"

            if not month_dates(month):
                dropped.append(f"{label}: unreadable month")
                continue
            if month < this_month:
                dropped.append(f"{label}: the month is over")
                continue

            # A `focusDate` was read off the document here and passed to
            # `FareWatch(focus=...)`. Nothing names a departure any more —
            # 12.260 took the field out of the model and 12.266 took the
            # parameter and the ordering it fed — so this script raised
            # `TypeError` on its first watch and had done since, which nobody
            # saw because the page collects over HTTP and this is the path a
            # scheduler uses. A stale `focusDate` left in the stored document is
            # now ignored the same way the web normalizer ignores it: read past,
            # not repaired.
            watch = FareWatch(
                origin=origin,
                destination=destination,
                month=month,
                currency=currency,
            )
            # Deduplicated across the whole document rather than within one
            # entry: the shapes can coexist while the browser has rewritten some
            # entries and not others, so `AEP-SCL 2027-03` can arrive from a
            # legacy entry and a plural one at once. `expand` would collapse the
            # queries anyway; what this protects is the per-watch cost line
            # printed below and the counts beside it.
            if watch in seen:
                continue
            seen.add(watch)
            watches.append(watch)
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
    parser.add_argument(
        "--no-calendar",
        action="store_true",
        help=(
            "Skip the whole-horizon calendar pass. It is 2.43 requests per city "
            "pair per day measured, so this is for isolating a board problem, "
            "not for saving budget."
        ),
    )
    args = parser.parse_args()

    # The pass's own record, opened before anything is read so that `wallMs`
    # measures the whole invocation — which is the figure that matters, because
    # the scheduled task is `MultipleInstances = IgnoreNew` every fifteen
    # minutes and what has to fit inside that interval is *this process*, boards
    # and horizon and start-up together, not either loop on its own. A pass that
    # overruns makes the next firing disappear without a word; `fare_passes`
    # carries the measurements.
    recorder = PassRecorder(
        source="cron",
        # Known here rather than at the end: it is a property of what was
        # invoked, not of what the pass found.
        kind="board" if args.no_calendar else "board+calendar",
        gap=args.gap if args.gap is not None else REQUEST_GAP_SECONDS,
    )
    try:
        return _pass(args, recorder)
    except BaseException:
        # **A pass that fell over is still a pass, and it still leaves a line.**
        # Before this the only trace was a non-zero exit code, and the comment
        # that justified relying on that assumed the Task Scheduler keeps a
        # history — its operational log is disabled on this machine, so the code
        # was going nowhere. `BaseException` rather than `Exception` because a
        # `KeyboardInterrupt` at 4m30s into a pass is exactly the ending a
        # reader would want on the line, and the re-raise leaves the exit
        # behaviour of the command untouched.
        recorder.finish(exit_code=1)
        raise


def _pass(args: argparse.Namespace, recorder: PassRecorder) -> int:
    """
    The pass itself: what is watched, what is due, and what came back.

    Split from `main` so the recorder above can wrap every ending in one place
    rather than in each `return`. Everything here is unchanged except the three
    calls into the collector, which now carry `recorder.pass_id` so the day's
    spend lines can be traced back to the pass that sent them.
    """
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
        print(
            f"  {watch.origin} -> {watch.destination}  departs in {watch.month}  "
            f"({collectable} of {len(month_dates(watch.month))} day(s) collectable, "
            f"{requests} request(s)/day)"
        )
    if not watches:
        print("nothing to do")
        # A watchlist with nothing in it is a real pass with nothing to do, and
        # it is the shape 99 of 105 firings had. A line here is what makes an
        # empty watchlist distinguishable from a scheduler that stopped firing.
        recorder.finish(exit_code=0)
        return 0

    # The calendar is per city pair, not per watch: one curve covers every month
    # at once, so two months on one pair are one collection. It is cheap enough
    # that its whole cost is a rounding error against the boards above — the
    # windows are what make it so, and they are printed for the same reason the
    # cadence demand is.
    #
    # Costed at the **measured** 2.43 requests per pair rather than at the two
    # windows it plans, because a far window is sometimes refused and walked
    # back and one check is 2 to 12 requests (12.245). Rounded up: a demand
    # figure that is read to decide whether a watchlist fits should not be the
    # optimistic end of a range.
    pairs = {(watch.origin, watch.destination) for watch in watches}
    windows = calendar_windows(datetime.now(UTC))
    calendar_demand = ceil(len(pairs) * CALENDAR_REQUESTS_PER_PAIR)
    demand += calendar_demand
    print(
        f"  calendar: {len(pairs)} city pair(s) x {len(windows)} window(s) "
        f"({windows[0][0]}..{windows[-1][1]}) at {CALENDAR_REQUESTS_PER_PAIR} measured "
        f"= {calendar_demand} request(s)/day"
    )

    # The cadence is what makes a month affordable, so the arithmetic is
    # printed rather than trusted. Over budget is not an error here: the pass
    # keeps the nearest departures and reports the rest as `over-budget`, which
    # is the honest shape of "you are watching more than a day's worth of".
    #
    # With no ceiling configured — the default — the demand is still printed and
    # there is simply nothing for it to fit inside. That is the figure worth
    # having either way: it is what this watchlist asks of the upstream every
    # day, and it is the number to bring to any argument about whether a ceiling
    # should come back and where it should sit.
    if budget is None:
        print(f"\ncadence demand: {demand} request(s)/day; no daily ceiling is set")
    else:
        fit = "fits" if demand <= budget else "OVER"
        print(f"\ncadence demand: {demand} request(s)/day against a budget of {budget} -- {fit}")

    # What one pass costs **in time**, which is a different question from what
    # the watchlist costs in requests and is the one with a silent failure
    # behind it.
    #
    # The scheduled task is `MultipleInstances = IgnoreNew` every
    # SCHEDULER_INTERVAL_MINUTES, so a pass that overruns makes the next firing
    # disappear without a word. The pass that overruns is also predictable: a
    # month added today has no heartbeats, so nothing in it is `not-due` and the
    # very next firing polls all thirty-one of its days. This is that worst
    # case, which is also the first case after an edit — printed where somebody
    # is deciding whether to add another month.
    gap = args.gap if args.gap is not None else REQUEST_GAP_SECONDS
    worst = sum(collectable for collectable, _ in (per_day(watch, today) for watch in watches))
    worst_minutes = worst * gap / 60
    print(
        f"  worst pass: {worst} departure(s) x {gap}s = {worst_minutes:.1f} min of pacing "
        f"against a {SCHEDULER_INTERVAL_MINUTES}-min scheduler interval -- "
        f"{'fits' if worst_minutes < SCHEDULER_INTERVAL_MINUTES else 'OVERRUNS'}"
    )

    # And what the day has actually spent, which is a different question from
    # what the watchlist costs and is the one that decides what this pass can
    # do. The demand above is a property of the watchlist; this is a property of
    # the day, and it is why the same watchlist collects at 08:00 and reports
    # `over-budget` at 23:00.
    allowance = daily_budget(now=datetime.now(UTC))
    left = allowance.remaining()
    print(
        f"today {allowance.day}: {allowance.spent()} request(s) already spent, "
        f"{'no ceiling' if left is None else f'{left} left'}"
        f" -> {allowance.ledger.path_for(allowance.day)}"
    )

    if args.dry_run:
        print("dry run; nothing was fetched")
        # **No line, on purpose.** A dry run returns before a client exists, is
        # never what the scheduler invokes, and has a person watching it. Its
        # duration would measure printing rather than collecting, and it would
        # sit in the same file as the ninety-six real passes a day. The existing
        # rule for `--dry-run` is that reaching nothing means writing nothing,
        # and the ledger stays inside it.
        return 0

    kwargs = {} if args.gap is None else {"gap_seconds": args.gap}
    # The boards get the scheduler's window minus what the horizon will want,
    # because `wallMs` measures the whole invocation and the boards run first on
    # purpose: a pass that runs out of goodwill should lose the cheap thing that
    # repeats tomorrow. `--all` is a person at a terminal rather than a
    # scheduler, so it carries no deadline — the same asymmetry `WINDOW_FULL`
    # records for a browser press.
    board_window = SCHEDULER_INTERVAL_MINUTES * 60 - (
        0 if args.no_calendar else calendar_demand * gap
    )
    if args.all:
        queries, unreadable = expand(watches)
        for what in unreadable:
            print(f"  -- {what}: unreadable month")
        # Nearest departure first. `--all` ignores the cadence and it does not
        # ignore the budget, so this list can still be cut short by the day
        # running out — and when it is, the rule has to be the one every other
        # truncation follows: keep the near departures, drop the far ones
        # (12.111). `expand` returns watchlist order, which is nobody's idea of
        # a spending priority.
        ordered = sorted(queries.values(), key=lambda query: query.flight_date)
        report = asyncio.run(collect(ordered, pass_id=recorder.pass_id, **kwargs))
    else:
        report = asyncio.run(
            collect_due(
                watches,
                pass_id=recorder.pass_id,
                deadline_seconds=board_window,
                **kwargs,
            )
        )
    recorder.tally.boards(report)

    if not args.no_calendar:
        # After the boards, not before. A pass that runs out of goodwill with
        # the upstream should lose the cheap thing that repeats tomorrow rather
        # than the boards, which are the reader's primary data and are the only
        # record of what today looked like.
        calendar_kwargs = dict(kwargs)
        if args.all:
            # `--all` means "ignore the cadence", and the calendar's cadence is
            # a single interval rather than a table. Zero minutes is what
            # "however recently you last looked" reads as here.
            calendar_kwargs["every_minutes"] = 0
        calendar = asyncio.run(
            collect_calendars(watches, pass_id=recorder.pass_id, **calendar_kwargs)
        )
        # Folded in before it is printed, so a pass that fails while printing a
        # summary still has the horizon's requests on its line. The boards and
        # the horizon share one `pass_id` because one invocation is one pass.
        recorder.tally.calendars(calendar)
        print()
        for route, reason in calendar.skipped:
            print(f"  --      {route}  calendar {reason}")
        for entry in calendar.results:
            if entry.ok:
                mark = "CHANGED" if entry.changed else "same   "
                cheapest = (
                    f"{entry.currency} {entry.cheapest:.2f} on {entry.cheapest_on}"
                    if entry.cheapest is not None
                    else "no price anywhere"
                )
                print(
                    f"  {mark} {entry.route} calendar  {entry.priced} of {entry.dates} "
                    f"day(s) priced, cheapest {cheapest}"
                )
            else:
                print(
                    f"  FAIL    {entry.route} calendar  {entry.error_code}: {entry.error_message}"
                )

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
    # A non-zero exit is what a wrapper or a shell would see, and it is now
    # also written down. This comment used to say the Task Scheduler records the
    # code "so a week of drift shows up in its history": that history is the
    # operational log, and on this machine it is **disabled** — checked, not
    # assumed — so the code was being reported to nothing at all. The line in
    # `fares/passes/` is where it now lands, beside the duration and the gap and
    # everything the pass skipped.
    code = 1 if report.failed else 0
    recorder.finish(exit_code=code)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
