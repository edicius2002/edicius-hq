"""
The day's request budget, and the ledger that makes it a day's.

Every other bound in this feature is measured. This one is a judgement, and it
is the only one that can reach somebody outside this machine: the upstream is a
Google Flights scraper running from a residential address because Google
fingerprints datacenter ones (12.9), there is no second provider, and the real
limit is how much traffic this address can send before it stops being answered.

It was also, until now, not enforced. `daily_request_budget()` was read once per
pass and spent as a counter local to one `due_now` call, so a cron every fifteen
minutes would give ninety-six passes the whole 600 each and the day's total
would be bounded by nothing at all. These tests are about the four things that
had to become true before that schedule could be turned on:

- **The command a scheduler would invoke actually runs.** It had raised
  `TypeError` on its first watch since the focus was removed, and every gate
  passed anyway.
- **Spend accumulates across passes and survives the process going away.** The
  collector is a stateless command invoked fresh, so anything held in memory is
  born at zero every time — which is the bug, not the fix.
- **A day boundary starts the budget again**, and nothing has to be run to make
  that happen.
- **Calendar requests are counted, and counted as sent.** One calendar look is
  2 to 12 HTTP requests because a refused far end is walked back (12.245), so a
  ledger keyed to looks would undercount exactly the pass this bounds.

Nothing here touches the network. Every upstream answer is a fixture behind an
`httpx.MockTransport`, and every store and ledger writes into `tmp_path`.
"""

import asyncio
import importlib.util
import json
import os
import re
import subprocess
import sys
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from app.adapters.fares.models import FareQuery
from app.services.fare_budget import RequestLedger, daily_budget
from app.services.fare_calendar import FareCalendar
from app.services.fare_collector import FareWatch, collect, collect_calendars, collect_due
from app.services.fare_history import FareHistory
from app.services.fare_schedule import month_dates

REPO_ROOT = Path(__file__).resolve().parents[3]
FIXTURES = Path(__file__).parent / "fixtures"

BOARD = "google_flights_lim_scl.html"
CALENDAR_CAPTURE = "google_flights_calendar_lim_cuz.txt"
CALENDAR_REFUSAL = "google_flights_calendar_refused.txt"

NOW = datetime(2026, 8, 18, 12, 0, tzinfo=UTC)
TODAY = NOW.date()


def read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def board_queries(month: str = "2026-10") -> list[FareQuery]:
    """One month of departures, nearest first — the order a pass spends in."""
    return [
        FareQuery(origin="LIM", destination="SCL", flight_date=day, return_date=None)
        for day in month_dates(month)
    ]


def a_pass(queries, *, ledger, ceiling, history, now=NOW):
    """
    One collection pass, built the way a freshly started process builds one.

    The allowance is constructed here rather than shared between calls, and the
    ledger is handed in rather than remembered, because that is the whole thing
    under test: two passes are two processes, and what they have in common is a
    file.
    """
    page = read_fixture(BOARD)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=page)) as client:
            return await collect(
                queries,
                history=history,
                client=client,
                gap_seconds=0,
                budget=daily_budget(ceiling=ceiling, ledger=ledger, now=now),
            )

    return asyncio.run(run())


# ----------------------------------------------------------- the ledger ----


def test_a_day_nobody_collected_on_has_spent_nothing(tmp_path):
    """
    The reset is a file that does not exist, not a counter somebody clears.

    Nothing runs at midnight and nothing has to: a new day names a new file, so
    the state that has to be got right at a boundary is state that is not there.
    """
    ledger = RequestLedger(tmp_path)
    assert ledger.spent(date(2026, 8, 21)) == 0
    assert not ledger.path_for(date(2026, 8, 21)).exists()


def test_a_request_is_recorded_with_what_it_was_spent_on(tmp_path):
    """
    The count is all the budget reads; the rest is for whoever asks later what
    600 requests went on, which is the next question anybody tuning the cadence
    table will have.
    """
    ledger = RequestLedger(tmp_path)
    day = date(2026, 8, 21)
    ledger.spend(day, kind="board", what="LIM-SCL 2026-10-01")
    ledger.spend(day, kind="calendar", what="LIM-CUZ 2026-08-21..2027-02-16")

    rows = [
        json.loads(line)
        for line in ledger.path_for(day).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert [row["kind"] for row in rows] == ["board", "calendar"]
    assert rows[0]["what"] == "LIM-SCL 2026-10-01"
    assert ledger.spent(day) == 2


def test_a_ledger_that_cannot_be_read_is_a_day_that_is_gone(tmp_path):
    """
    Fail closed, and loudly.

    Guessing low is the only guess that spends the thing the budget protects, so
    a day whose spend cannot be established is treated as fully spent. That is
    not a silent stop: every departure comes back `over-budget` by name in the
    report, which is 8.8 doing what it is for.
    """
    ledger = RequestLedger(tmp_path)
    day = date(2026, 8, 21)
    # A directory where the day's file should be: `exists()` is true and
    # `read_text` is not going to work.
    ledger.path_for(day).mkdir(parents=True)

    assert ledger.spent(day) is None
    allowance = daily_budget(ceiling=600, ledger=ledger, now=datetime(2026, 8, 21, tzinfo=UTC))
    assert allowance.spent() == 600
    assert allowance.remaining() == 0


def test_the_day_a_pass_spends_against_is_fixed_when_it_starts(tmp_path):
    """
    A pass that begins at 23:58 keeps spending against the day it began in.

    Re-deriving the date per request would hand a running pass a fresh ceiling
    part way through — the same hole as reading the budget once per pass, with a
    rarer trigger.
    """
    allowance = daily_budget(
        ceiling=600,
        ledger=RequestLedger(tmp_path),
        now=datetime(2026, 8, 21, 23, 58, tzinfo=UTC),
    )
    assert allowance.day == date(2026, 8, 21)
    for _ in range(3):
        allowance.take(kind="board", what="LIM-SCL 2026-10-01")
    assert RequestLedger(tmp_path).spent(date(2026, 8, 21)) == 3
    assert RequestLedger(tmp_path).spent(date(2026, 8, 22)) == 0


# ------------------------------------------------- across passes and days ----


def test_spend_accumulates_across_two_passes_and_a_restart(tmp_path):
    """
    The gap this whole change exists to close.

    Two passes, four requests of budget, three departures offered to each. The
    second pass is built from a **new** `RequestLedger` on the same directory —
    a different object, which is what a scheduled command that starts fresh
    every fifteen minutes actually is — and it gets one request rather than
    three, because the day it is spending from is on disk and not in a process.

    Before this, both passes saw a budget of four and the day cost six.
    """
    history = FareHistory(tmp_path / "fares")
    spend = tmp_path / "spend"
    queries = board_queries()[:3]

    first = a_pass(queries, ledger=RequestLedger(spend), ceiling=4, history=history)
    assert len(first.results) == 3
    assert first.skipped == []

    second = a_pass(queries, ledger=RequestLedger(spend), ceiling=4, history=history)
    assert [result.flight_date for result in second.results] == ["2026-10-01"]
    assert second.skipped == [
        ("LIM-SCL 2026-10-02", "over-budget"),
        ("LIM-SCL 2026-10-03", "over-budget"),
    ]

    assert RequestLedger(spend).spent(TODAY) == 4


def test_a_new_day_starts_the_budget_again(tmp_path):
    """
    Midnight is the reset and nothing has to run for it.

    The same watchlist that could buy nothing at 23:59 buys its full allowance
    at 00:01, because the pass is reading a file named after the day and the day
    changed. Yesterday's file is left alone: it is the record of yesterday.
    """
    history = FareHistory(tmp_path / "fares")
    spend = tmp_path / "spend"
    queries = board_queries()[:3]

    a_pass(queries, ledger=RequestLedger(spend), ceiling=3, history=history)
    spent_out = a_pass(queries, ledger=RequestLedger(spend), ceiling=3, history=history)
    assert spent_out.results == []
    assert len(spent_out.skipped) == 3

    tomorrow = NOW + timedelta(days=1)
    fresh = a_pass(queries, ledger=RequestLedger(spend), ceiling=3, history=history, now=tomorrow)
    assert len(fresh.results) == 3
    assert fresh.skipped == []

    ledger = RequestLedger(spend)
    assert ledger.spent(TODAY) == 3
    assert ledger.spent(tomorrow.date()) == 3


def test_a_day_that_runs_out_mid_pass_keeps_the_nearest_departures(tmp_path):
    """
    12.111 arriving by a second route.

    The pass was sized against a day with room in it and the day filled up while
    it ran — another pass, or the calendar, spending underneath it. The rule has
    to be the one every other truncation follows: the near departures are the
    ones the measurement says actually move, so they are what the pass keeps and
    the far ones are what it reports.

    The concurrent spender here is the mock transport itself, which writes three
    requests to the ledger as it answers the first one. That is exactly the
    shape of the race — nothing in this process decided to spend them.
    """
    history = FareHistory(tmp_path / "fares")
    ledger = RequestLedger(tmp_path / "spend")
    queries = board_queries()[:6]
    page = read_fixture(BOARD)
    answered = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal answered
        answered += 1
        if answered == 1:
            for _ in range(3):
                ledger.spend(TODAY, kind="board", what="somebody else's pass")
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect(
                queries,
                history=history,
                client=client,
                gap_seconds=0,
                budget=daily_budget(ceiling=5, ledger=ledger, now=NOW),
            )

    report = asyncio.run(run())
    # One request of our own plus three of somebody else's is four; the fifth is
    # ours and then the day is gone.
    assert [result.flight_date for result in report.results] == ["2026-10-01", "2026-10-02"]
    assert [what for what, _ in report.skipped] == [
        "LIM-SCL 2026-10-03",
        "LIM-SCL 2026-10-04",
        "LIM-SCL 2026-10-05",
        "LIM-SCL 2026-10-06",
    ]
    assert {reason for _, reason in report.skipped} == {"over-budget"}


def test_a_scheduled_pass_on_a_spent_day_polls_nothing_and_says_so(tmp_path):
    """
    `collect_due` sizes itself against what is **left** of the day.

    Thirty-one departures, all of them due, against a day that has already spent
    599 of 600. One request is bought, thirty are named — which is the honest
    shape of "you are watching more than the day can carry" and is the same
    `over-budget` word a per-pass truncation has always used.
    """
    history = FareHistory(tmp_path / "fares")
    ledger = RequestLedger(tmp_path / "spend")
    for _ in range(599):
        ledger.spend(TODAY, kind="board", what="earlier today")
    page = read_fixture(BOARD)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=page)) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10")],
                now=NOW,
                budget=600,
                history=history,
                client=client,
                gap_seconds=0,
                ledger=ledger,
            )

    report = asyncio.run(run())
    assert [result.flight_date for result in report.results] == ["2026-10-01"]
    assert sum(1 for _, reason in report.skipped if reason == "over-budget") == 30
    assert ledger.spent(TODAY) == 600


# ------------------------------------------------------------ the calendar --


def test_a_calendar_request_is_counted_including_the_walk_back(tmp_path):
    """
    2.43 and not 2, which is the whole reason the ledger counts requests.

    The same pass `test_a_far_end_the_provider_will_not_price_is_walked_back`
    covers next door: two windows, the far one refused and asked again one day
    shorter. Three requests left this address and the archive recorded **one**
    look, so a budget read off the heartbeats would have been told 2 — or 1 —
    for a pass that sent 3.
    """
    store = FareCalendar(tmp_path / "calendar")
    ledger = RequestLedger(tmp_path / "spend")
    page = read_fixture(CALENDAR_CAPTURE)
    refusal = read_fixture(CALENDAR_REFUSAL)
    moment = datetime(2026, 8, 20, 12, 0, tzinfo=UTC)

    def handler(request: httpx.Request) -> httpx.Response:
        window = re.findall(r"\d{4}-\d{2}-\d{2}", request.content.decode("utf-8"))[-2:]
        if window[1] > "2027-07-15":
            return httpx.Response(200, text=refusal)
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("ARI", "SCL", "2027-03")],
                now=moment,
                calendar=store,
                client=client,
                gap_seconds=0,
                budget=600,
                ledger=ledger,
            )

    report = asyncio.run(run())
    assert report.failed == 0
    assert report.requests == 3
    assert ledger.spent(moment.date()) == 3
    kinds = {
        json.loads(line)["kind"]
        for line in ledger.path_for(moment.date()).read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    assert kinds == {"calendar"}
    # One heartbeat for three requests. This is the number a ledger keyed to
    # looks would have believed.
    assert len(store.checks("ARI", "SCL")) == 1


def test_a_pair_that_cannot_afford_its_windows_is_skipped_before_it_is_begun(tmp_path):
    """
    Two windows are one observation of one year and half a curve is never
    stored (12.4), so a pair is begun only if the whole of it fits.

    Watchlist order decides who goes short, because a curve spans every distance
    from today to the horizon at once and so has no nearest-first to sort by —
    the boards' rule does not translate and is not borrowed.
    """
    store = FareCalendar(tmp_path / "calendar")
    ledger = RequestLedger(tmp_path / "spend")
    moment = datetime(2026, 8, 20, 12, 0, tzinfo=UTC)
    page = read_fixture(CALENDAR_CAPTURE)
    asked = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal asked
        asked += 1
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("ARI", "SCL", "2027-03"), FareWatch("LIM", "CUZ", "2027-03")],
                now=moment,
                calendar=store,
                client=client,
                gap_seconds=0,
                budget=2,
                ledger=ledger,
            )

    report = asyncio.run(run())
    assert [result.route for result in report.results] == ["ARI-SCL"]
    assert report.skipped == [("LIM-CUZ", "over-budget")]
    # The second pair cost nothing at all: it was refused a start, not started
    # and abandoned.
    assert asked == 2
    assert ledger.spent(moment.date()) == 2


def test_a_curve_that_runs_out_of_day_fails_rather_than_storing_half_a_year(tmp_path):
    """
    The walk-back is what can push a pair past the allowance it was allotted,
    because a pair is allotted one request per window and can spend six.

    When that happens the curve fails, with its own code, and nothing is
    written. Storing the windows that did answer would put a year in the archive
    that stops in February for a reason the file does not record — the same
    quiet partial answer 12.4 forbids a refusal from producing.
    """
    store = FareCalendar(tmp_path / "calendar")
    ledger = RequestLedger(tmp_path / "spend")
    moment = datetime(2026, 8, 20, 12, 0, tzinfo=UTC)
    page = read_fixture(CALENDAR_CAPTURE)
    refusal = read_fixture(CALENDAR_REFUSAL)

    def handler(request: httpx.Request) -> httpx.Response:
        window = re.findall(r"\d{4}-\d{2}-\d{2}", request.content.decode("utf-8"))[-2:]
        if window[1] > "2027-07-15":
            return httpx.Response(200, text=refusal)
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("ARI", "SCL", "2027-03")],
                now=moment,
                calendar=store,
                client=client,
                gap_seconds=0,
                # Exactly the two windows this pair plans, and one short of the
                # three the walk-back turns out to need.
                budget=2,
                ledger=ledger,
            )

    report = asyncio.run(run())
    assert report.failed == 1
    assert report.results[0].error_code == "budget-exhausted"
    assert store.latest("ARI", "SCL") is None
    assert ledger.spent(moment.date()) == 2


def test_the_boards_and_the_calendar_spend_from_one_day(tmp_path):
    """
    One address, one day, one number.

    The calendar used to take no budget at all. At today's daily cadence that is
    about 12 requests and invisible; at an hourly refresh it would be ~350 —
    more than the whole ceiling — spent on the far months while the month the
    reader is actually watching went unpolled.
    """
    history = FareHistory(tmp_path / "fares")
    store = FareCalendar(tmp_path / "calendar")
    ledger = RequestLedger(tmp_path / "spend")
    curve = read_fixture(CALENDAR_CAPTURE)

    a_pass(board_queries()[:4], ledger=ledger, ceiling=6, history=history)
    assert ledger.spent(TODAY) == 4

    async def run():
        async with transport(lambda request: httpx.Response(200, text=curve)) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03"), FareWatch("ARI", "SCL", "2027-03")],
                now=NOW,
                calendar=store,
                client=client,
                gap_seconds=0,
                budget=6,
                ledger=ledger,
            )

    report = asyncio.run(run())
    # Four boards leave two of six, which is one pair's two windows. The second
    # pair is over budget on a ceiling the boards spent most of.
    assert [result.route for result in report.results] == ["LIM-CUZ"]
    assert report.skipped == [("ARI-SCL", "over-budget")]
    assert ledger.spent(TODAY) == 6


# --------------------------------------------------- the scheduled command --


def load_collect_script():
    """
    `scripts/fares-collect.py` as a module.

    Loaded by path because the filename is not an identifier, which is also part
    of why nothing imported it and nothing noticed it was broken.
    """
    path = REPO_ROOT / "scripts" / "fares-collect.py"
    spec = importlib.util.spec_from_file_location("fares_collect_script", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_a_stored_route_still_naming_a_focus_becomes_a_watch(tmp_path):
    """
    The crash, in one line.

    This script read `focusDate` off the stored document and passed `focus=` to
    `FareWatch`. 12.260 took the field out of the model and 12.266 took the
    parameter, so the first watch raised `TypeError` and the whole pass died
    before a single request — since 2026-08-20, unnoticed, because the page
    collects over HTTP and this is the path a scheduler would use.

    A document that still carries the old field is read past rather than
    repaired, which is what the web normalizer does with it too.
    """
    script = load_collect_script()
    watches, dropped = script.to_watches(
        [
            {
                "origin": "aqp",
                "destination": "lim",
                "month": "2026-11",
                "currency": "usd",
                "focusDate": "2026-11-14",
            }
        ]
    )
    assert dropped == []
    assert len(watches) == 1
    assert (watches[0].origin, watches[0].destination, watches[0].month) == (
        "AQP",
        "LIM",
        "2026-11",
    )
    assert not hasattr(watches[0], "focus")


@pytest.mark.skipif(
    not (REPO_ROOT / "scripts" / "fares-collect.py").exists(),
    reason="the collector script is not in this checkout",
)
def test_the_scheduled_command_runs_a_whole_dry_pass(tmp_path):
    """
    The gate that would have caught it, run the way a scheduler runs it.

    Every existing check passed while this file could not start: ruff cannot see
    an argument name that no longer exists — it is a type question — and mypy was
    pointed at `app` alone, so the one file a scheduled task would invoke was the
    one file nothing typechecked. `files` now covers the scripts as well, and
    this runs the thing end to end on top of that.

    `--dry-run` reaches nothing, which is the only way this may ever be tested:
    one real request from a test is one real request from this address.
    """
    data = tmp_path / "local-data"
    (data / "kv").mkdir(parents=True)
    (data / "kv" / "airfare-routes.json").write_text(
        json.dumps(
            {
                "routes": [
                    {
                        "origin": "AQP",
                        "destination": "LIM",
                        "month": "2026-11",
                        "currency": "USD",
                        "focusDate": "2026-11-14",
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    finished = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "fares-collect.py"), "--dry-run"],
        capture_output=True,
        text=True,
        env={**os.environ, "LOCAL_DATA_DIR": str(data)},
        cwd=str(REPO_ROOT / "services" / "api"),
        timeout=120,
    )

    assert finished.returncode == 0, finished.stderr
    assert "1 route(s), 1 watchable, 0 dropped" in finished.stdout
    assert "dry run; nothing was fetched" in finished.stdout
    # And it says what the day has left, which is the figure that decides what a
    # pass can do and is a different question from what the watchlist costs.
    assert "0 request(s) already spent" in finished.stdout
    # Reaching nothing means writing nothing, the ledger included.
    assert not (data / "fares" / "spend").exists()
