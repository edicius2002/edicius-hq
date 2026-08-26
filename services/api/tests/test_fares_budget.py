"""
The day's request ledger, and the ceiling that is no longer over it by default.

Every other bound in this feature is measured. The ceiling never was: the real
limit is how much traffic this address can send before Google stops answering —
it runs from a residential one because datacenter addresses are fingerprinted
(12.9) and there is no second provider — and that number is unknown and cannot
be probed without spending the thing it protects. So `daily_request_budget()`
answers `None` unless an environment sets one, and the three tests named for it
below pin both halves: nothing is refused by default, and the whole enforcement
comes back with `FARES_DAILY_REQUEST_BUDGET`. Every other test here passes an
explicit ceiling, which is what keeps that path proven.

**The ledger is unconditional and is what these tests are mostly about.** It
still writes one line per request before it leaves, whether or not anything is
counting against it, because what a day cost is the question a future ceiling
would have to be sized against and the page in the browser reads it back.

That ledger, and the pass lock beside it, exist because spend was once read once
per pass and spent as a counter local to one `due_now` call, so a cron every
fifteen minutes would give ninety-six passes a whole day's allowance each. These
tests are about the four things that had to become true before that schedule
could be turned on:

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

import argparse
import asyncio
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from app.adapters.fares.models import FareQuery
from app.config import SCHEDULER_INTERVAL_MINUTES, SPEND_RETENTION_DAYS
from app.services import fare_collector
from app.services.fare_budget import (
    CALENDAR_LOCK_NAME,
    LOCK_STALE_SECONDS,
    PassLock,
    RequestLedger,
    daily_budget,
)
from app.services.fare_calendar import FareCalendar
from app.services.fare_collector import (
    WINDOW_FULL,
    CollectionReport,
    FareWatch,
    collect,
    collect_calendars,
    collect_due,
)
from app.services.fare_history import FareHistory
from app.services.fare_passes import PassRecorder
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


def test_a_request_records_the_pace_it_was_sent_at_and_the_pass_that_sent_it(tmp_path):
    """
    The gap was nowhere on disk, so it was reconstructed and called evidence.

    Separating a 1.75-second population of requests from a 3.0-second one meant
    taking the modal delta between consecutive `at` values, which is inference
    about a number the process knew exactly at the time. Written on the line, it
    is a read. `passId` is beside it because the other half of the question —
    which pass sent this — was answered the same way, by grouping timestamps.

    End to end through `collect` rather than by calling `spend` directly: the
    point is that the pace reaching the line is the pace the loop actually slept
    for, and a test that handed the number to the writer itself would prove
    nothing about the wiring in between.
    """
    ledger = RequestLedger(tmp_path / "spend")
    page = read_fixture(BOARD)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=page)) as client:
            return await collect(
                board_queries()[:1],
                history=FareHistory(tmp_path / "history"),
                client=client,
                gap_seconds=1.75,
                budget=daily_budget(
                    ceiling=None,
                    ledger=ledger,
                    now=NOW,
                    gap=1.75,
                    pass_id="0123456789ab",
                ),
            )

    asyncio.run(run())

    rows = [
        json.loads(line)
        for line in ledger.path_for(TODAY).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert [(row["gap"], row["passId"]) for row in rows] == [(1.75, "0123456789ab")]


def test_a_line_written_without_a_pass_says_so_by_leaving_the_fields_out(tmp_path):
    """
    An unknown gap is an absent field, not a null and not a zero.

    952 lines were written before either field existed, and they are requests
    whose pace is genuinely unrecoverable. `null` would be a claim about a gap
    of nothing and `0` a claim about no pacing at all; leaving the key out is
    what an old line already looks like, so a reader has exactly one shape to
    handle rather than two.
    """
    ledger = RequestLedger(tmp_path)
    day = date(2026, 8, 21)
    ledger.spend(day, kind="board", what="LIM-SCL 2026-10-01")

    [row] = [
        json.loads(line)
        for line in ledger.path_for(day).read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    assert row == {"at": row["at"], "kind": "board", "what": "LIM-SCL 2026-10-01"}


def test_a_day_file_written_before_the_pace_existed_still_counts(tmp_path):
    """
    **The 952 lines already on disk, and the two readers that must not break.**

    `spent` counts lines and never parses them, which is why an old line costs
    nothing here — but that is a property worth pinning rather than assuming,
    because it is what `DailyBudget` builds the day's total from and what the
    page in the browser is shown. A file with both shapes in it is the real
    case: the day the field arrives has old lines above it and new ones below.
    """
    ledger = RequestLedger(tmp_path)
    day = date(2026, 8, 21)
    path = ledger.path_for(day)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {"at": "2026-08-21T09:00:00+00:00", "kind": "board", "what": "LIM-SCL 2026-10-01"}
        )
        + "\n"
        + json.dumps({"at": "2026-08-21T09:00:03+00:00", "kind": "calendar", "what": "LIM-CUZ"})
        + "\n",
        encoding="utf-8",
    )
    ledger.spend(day, kind="board", what="LIM-SCL 2026-10-02", gap=1.75, pass_id="0123456789ab")

    assert ledger.spent(day) == 3
    allowance = daily_budget(ceiling=600, ledger=ledger, now=datetime(2026, 8, 21, tzinfo=UTC))
    assert allowance.spent() == 3
    assert allowance.remaining() == 597


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


def test_a_pass_with_no_ceiling_polls_every_due_departure(tmp_path):
    """
    The default, and the point of `a-count-nobody-measured-does-not-stop-a-pass`.

    The same watchlist and the same already-busy day as the test below, with the
    ceiling off: all thirty-one departures are polled, nothing is named
    `over-budget`, and every request is still written to the ledger. What the
    day cost is recorded exactly as before; what changed is that recording it is
    no longer the same act as refusing it.
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
                # No `budget=`, so the configured ceiling is used and there is
                # not one — the same path a scheduled pass takes.
                history=history,
                client=client,
                gap_seconds=0,
                ledger=ledger,
            )

    report = asyncio.run(run())
    assert len(report.results) == 31
    assert not [reason for _, reason in report.skipped if reason == "over-budget"]
    assert ledger.spent(TODAY) == 599 + 31


def test_with_no_ceiling_an_unreadable_ledger_does_not_stop_the_collector(tmp_path):
    """
    The inversion that comes with the ceiling going away, and the one worth
    pinning by name.

    Failing closed on an unreadable ledger existed so an unknown total could not
    be compared favourably against a ceiling. With no ceiling nothing is
    compared, and stopping would mean the ledger's own writability decided
    whether fares are collected — which it was never meant to be. The day's
    record is what is lost, and the log line in `RequestLedger.spent` is what
    says so.
    """
    history = FareHistory(tmp_path / "fares")
    ledger = RequestLedger(tmp_path / "spend")
    # A directory where the day's file goes: `exists()` is true and the read is
    # not going to work.
    ledger.path_for(TODAY).mkdir(parents=True)
    assert ledger.spent(TODAY) is None

    allowance = daily_budget(ledger=ledger, now=NOW)
    assert allowance.ceiling is None
    assert allowance.remaining() is None
    assert allowance.affords(10_000)

    page = read_fixture(BOARD)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=page)) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10")],
                now=NOW,
                history=history,
                client=client,
                gap_seconds=0,
                ledger=ledger,
            )

    report = asyncio.run(run())
    assert len(report.results) == 31
    assert not [reason for _, reason in report.skipped if reason == "over-budget"]


def test_a_ceiling_set_in_the_environment_is_enforced_again(tmp_path, monkeypatch):
    """
    Nothing was deleted, only defaulted off: an environment that sets a number
    gets the whole of the old behaviour back, through the same path a pass takes
    when no caller hands it a ceiling.
    """
    monkeypatch.setenv("FARES_DAILY_REQUEST_BUDGET", "600")
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
                history=history,
                client=client,
                gap_seconds=0,
                ledger=ledger,
            )

    report = asyncio.run(run())
    assert [result.flight_date for result in report.results] == ["2026-10-01"]
    assert sum(1 for _, reason in report.skipped if reason == "over-budget") == 30


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


# ------------------------------------------------------- one pass at a time --
#
# The ledger bounds the day only *eventually*. `DailyBudget.spent()` re-reads the
# file before every request, so a second spender is noticed within one request —
# but only once both passes have already planned. Two starting together each read
# a day with 600 left, each size a whole day of work against that, and each begin
# spending before either can see the other. `CollectionRunner` serialises passes
# inside the API process and cannot see the scheduled command, which is a second
# process. These are about the file that both of them can see.


def a_lock(tmp_path, **kwargs) -> PassLock:
    """A lock at a path two `PassLock` objects can both name, as two processes do."""
    return PassLock(tmp_path / "collect.lock", **kwargs)


def refuses(request: httpx.Request) -> httpx.Response:
    raise AssertionError(f"a declined pass reached the upstream: {request.url}")


def test_only_one_pass_at_a_time_holds_the_lock(tmp_path):
    """
    Two objects, one file — which is what two processes are.

    Nothing waits. A pass is minutes long, so a second one queueing behind the
    first would be a scheduled task sitting on the machine for the length of it,
    only to run against a day the first had already spent.
    """
    first, second = a_lock(tmp_path), a_lock(tmp_path)

    assert first.acquire() is True
    assert second.acquire() is False
    assert second.held() is False

    first.release()
    assert second.acquire() is True
    second.release()
    assert not (tmp_path / "collect.lock").exists()


def test_two_spenders_do_not_both_plan_a_whole_day(tmp_path):
    """
    The hole this closes, stated as the arithmetic it used to produce.

    Thirty-one departures, every one of them due, against a fresh 600. Without a
    lock the second pass reads a day with 600 left — because the first has not
    written a line yet — sizes thirty-one requests against it, and starts
    sending. Both passes then discover each other one request at a time, having
    each already committed to a whole day's work.

    With the lock, the second pass sends nothing at all and the ledger says so.
    The upstream here fails the test if it is touched.
    """
    history = FareHistory(tmp_path / "fares")
    ledger = RequestLedger(tmp_path / "spend")
    held = a_lock(tmp_path)
    assert held.acquire()

    async def run():
        async with transport(refuses) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10")],
                now=NOW,
                budget=600,
                history=history,
                client=client,
                gap_seconds=0,
                ledger=ledger,
                lock=a_lock(tmp_path),
            )

    report = asyncio.run(run())
    assert report.results == []
    assert len(report.skipped) == 31
    assert {reason for _, reason in report.skipped} == {"another-pass-is-running"}
    # Nothing planned means nothing spent: the day is exactly as the pass that
    # actually holds the lock left it.
    assert ledger.spent(TODAY) == 0
    # And declining did not take the lock away from the pass that has it.
    assert held.held() is True
    assert a_lock(tmp_path).acquire() is False


def test_a_declined_pass_reports_rather_than_raising(tmp_path):
    """
    Being second is ordinary, so it reads like `over-budget` and not like an
    error.

    A cron firing while the owner presses Collect is the case the schedule
    creates, not a fault, so every departure is named in `skipped` with a reason
    — 8.8 and 8.41 — and an observer hears a denominator of zero rather than
    watching a bar spin on a pass that is never going to move.
    """
    history = FareHistory(tmp_path / "fares")
    planned: list[tuple[int, list[tuple[str, str]]]] = []

    class Watcher:
        def planned(self, *, polling, skipped):
            planned.append((polling, skipped))

        def collected(self, result, snapshot=None):
            raise AssertionError("a declined pass collected something")

    assert a_lock(tmp_path).acquire()

    async def run():
        async with transport(refuses) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10"), FareWatch("AQP", "LIM", "not-a-month")],
                now=NOW,
                budget=600,
                history=history,
                client=client,
                gap_seconds=0,
                ledger=RequestLedger(tmp_path / "spend"),
                lock=a_lock(tmp_path),
                observer=Watcher(),
            )

    report = asyncio.run(run())
    assert report.source == "google-flights"
    assert report.collected == 0 and report.failed == 0
    # The month nobody can read is still reported as unreadable rather than
    # being swept into the decline: two different things did not happen.
    assert ("AQP-LIM not-a-month", "unreadable-month") in report.skipped
    assert ("LIM-SCL 2026-10-01", "another-pass-is-running") in report.skipped
    assert planned == [(0, report.skipped)]


# --------------------------------------------- a forced press meets them both --
#
# `a-press-collects-the-month-it-is-on` lets one reader overrule the cadence for
# one route-month. It lets them overrule nothing else, and these are the two
# things it must not be able to reach: the day's ledger and the pass lock. Both
# are asserted by counting what left the address rather than by reading the
# report, because the report is what would be believed if it were wrong.


def a_forced_month(tmp_path, *, lock=None, ledger=None, ceiling=600):
    """One route-month, forced, against a transport that counts what reaches it."""
    history = FareHistory(tmp_path / "fares")
    page = read_fixture(BOARD)
    sent: list[str] = []

    def answer(request: httpx.Request) -> httpx.Response:
        sent.append(str(request.url))
        return httpx.Response(200, text=page)

    async def run():
        async with transport(answer) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10")],
                now=NOW,
                budget=ceiling,
                history=history,
                client=client,
                gap_seconds=0,
                ledger=ledger if ledger is not None else RequestLedger(tmp_path / "spend"),
                lock=lock,
                force=True,
            )

    return asyncio.run(run()), sent


def test_a_forced_press_on_a_spent_day_polls_nothing_and_says_over_budget(tmp_path):
    """
    The reader may overrule the cadence. Nobody may overrule the day.

    Six hundred of six hundred already sent, and a press that ignores the
    schedule: thirty-one departures come back `over-budget` by name, the
    transport is never reached, and the ledger is exactly where it was. That
    last pair is what matters — a report saying `over-budget` while requests
    went out anyway is the failure this exists to exclude, and only counting
    what left the address can tell the two apart.

    `over-budget` is also already a word the row renders verbatim, so nothing on
    the web had to learn a new refusal in order to say this.
    """
    ledger = RequestLedger(tmp_path / "spend")
    for _ in range(600):
        ledger.spend(TODAY, kind="board", what="earlier today")

    report, sent = a_forced_month(tmp_path, ledger=ledger)

    assert sent == []
    assert report.results == []
    assert sum(1 for _, reason in report.skipped if reason == "over-budget") == 31
    assert ("LIM-SCL 2026-10-01", "over-budget") in report.skipped
    assert ledger.spent(TODAY) == 600


def test_a_forced_press_that_meets_a_running_pass_sends_nothing(tmp_path):
    """
    Being second is not an error, and a press cannot make it one.

    The scheduled collector is a separate process holding a lock file, which is
    the case `PassLock` exists for — the runner's single slot cannot see it. A
    forced press that arrives then plans nothing, sends nothing, spends nothing
    and names every departure `another-pass-is-running`, which is the same shape
    and the same place in a report as `over-budget`.

    The lock is taken here before the pass rather than inside it, so this is the
    real ordering: the press loses the file, not a race inside one process.
    """
    scheduled = a_lock(tmp_path)
    assert scheduled.acquire()
    ledger = RequestLedger(tmp_path / "spend")

    report, sent = a_forced_month(tmp_path, lock=a_lock(tmp_path), ledger=ledger)

    assert sent == []
    assert report.results == []
    assert sum(1 for _, reason in report.skipped if reason == "another-pass-is-running") == 31
    assert ledger.spent(TODAY) == 0

    # And the press did not take the lock away from the pass that was holding it.
    scheduled.release()
    assert not a_lock(tmp_path).path.exists()


def test_a_forced_press_that_gets_the_lock_gives_it_back(tmp_path):
    """
    The other side of the one above, so the decline is not bought with a wedge.

    A forced pass is an ordinary pass in every respect but its plan: it takes
    the lock, spends thirty-one requests against the day one line at a time, and
    leaves the file gone behind it. Otherwise the next scheduled pass would
    decline for five minutes because a reader pressed a button.
    """
    ledger = RequestLedger(tmp_path / "spend")
    report, sent = a_forced_month(tmp_path, lock=a_lock(tmp_path), ledger=ledger)

    assert len(sent) == 31
    assert len(report.results) == 31 and report.skipped == []
    assert ledger.spent(TODAY) == 31
    assert not a_lock(tmp_path).path.exists()


def test_a_declined_calendar_pass_names_its_pairs(tmp_path):
    """
    The whole-horizon pass declines the same way, per city pair.

    It takes the lock separately from the boards because the command runs the
    two passes one after the other — the boards' lock is released when the
    boards are done — so each is independently able to be the second one.
    """
    assert a_lock(tmp_path).acquire()

    async def run():
        async with transport(refuses) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03"), FareWatch("ARI", "SCL", "2027-03")],
                now=NOW,
                calendar=FareCalendar(tmp_path / "calendar"),
                client=client,
                gap_seconds=0,
                budget=600,
                ledger=RequestLedger(tmp_path / "spend"),
                lock=a_lock(tmp_path),
            )

    report = asyncio.run(run())
    assert report.results == []
    assert report.skipped == [
        ("LIM-CUZ", "another-pass-is-running"),
        ("ARI-SCL", "another-pass-is-running"),
    ]
    assert report.requests == 0


def test_a_list_somebody_assembled_by_hand_is_a_pass_too(tmp_path):
    """
    `--all` goes straight to `collect`, so `collect` is a top of a pass as well.

    It takes the lock only when it was handed no budget, which is exactly the
    signal that nobody above it is holding one — `collect_due` hands its
    allowance down and would otherwise deadlock this against itself.
    """
    assert a_lock(tmp_path).acquire()

    async def run():
        async with transport(refuses) as client:
            return await collect(
                board_queries()[:4],
                history=FareHistory(tmp_path / "fares"),
                client=client,
                gap_seconds=0,
                lock=a_lock(tmp_path),
            )

    report = asyncio.run(run())
    assert report.results == []
    assert report.skipped == [
        ("LIM-SCL 2026-10-01", "another-pass-is-running"),
        ("LIM-SCL 2026-10-02", "another-pass-is-running"),
        ("LIM-SCL 2026-10-03", "another-pass-is-running"),
        ("LIM-SCL 2026-10-04", "another-pass-is-running"),
    ]


def test_a_pass_gives_the_lock_back_even_when_it_falls_over(tmp_path):
    """
    A pass that raises must not wedge the collector until the lock goes stale.

    The store is the thing that breaks here, before a single request, which is
    the case the release has to survive: it happens outside the upstream
    session's own cleanup because at that point there is no session yet.
    """
    broken = FareHistory(tmp_path / "fares")
    broken.last_checked = lambda: (_ for _ in ()).throw(RuntimeError("the archive fell over"))

    async def run():
        async with transport(refuses) as client:
            return await collect_due(
                [FareWatch("LIM", "SCL", "2026-10")],
                now=NOW,
                budget=600,
                history=broken,
                client=client,
                gap_seconds=0,
                ledger=RequestLedger(tmp_path / "spend"),
                lock=a_lock(tmp_path),
            )

    with pytest.raises(RuntimeError):
        asyncio.run(run())
    assert a_lock(tmp_path).acquire() is True


def test_a_lock_nothing_has_touched_is_cleared_by_the_next_pass(tmp_path):
    """
    A process killed mid-pass leaves its lock behind, and must not wedge the
    collector forever.

    Staleness is timed against the **silence**, not against the work. The holder
    refreshes the lock before every request it sends, so the longest gap a living
    pass can produce is one paced wait plus one upstream timeout — 3 + 12
    seconds. Timing the work instead would need a bound of 600 requests times
    fifteen seconds, and a pass killed at its first request would then wedge the
    collector for two and a half hours.
    """
    abandoned = a_lock(tmp_path)
    assert abandoned.acquire()

    path = tmp_path / "collect.lock"
    fresh = a_lock(tmp_path)
    assert fresh.acquire() is False

    # The process it belonged to is gone; nothing touches it again.
    long_ago = time.time() - LOCK_STALE_SECONDS - 1
    os.utime(path, (long_ago, long_ago))

    assert fresh.acquire() is True
    assert path.exists()
    # And the new holder's lock is its own, not the corpse it cleared.
    fresh.release()
    assert not path.exists()


def test_a_pass_that_lost_its_lock_does_not_delete_the_one_that_replaced_it(tmp_path):
    """
    Why clearing a stale lock is not itself a race.

    Two things have to hold. **Nothing is deleted that was not first taken
    exclusively**: the clearing is `os.replace` to a name only the caller knows,
    and a file can be moved away exactly once, so the loser finds no source and
    declines — after which the winner still has to win the ordinary `O_EXCL`
    create, which is the one arbiter. And **the pass that was cleared cannot
    undo it**: the lock names its holder, so the frozen pass — a laptop
    suspended mid-pass is the realistic way — finds a token that is not its own
    and neither refreshes nor removes it.

    `stale_after=0` is the same situation with the waiting taken out.
    """
    frozen = a_lock(tmp_path, stale_after=0.0)
    assert frozen.acquire()
    replacement = a_lock(tmp_path, stale_after=0.0)
    assert replacement.acquire()

    path = tmp_path / "collect.lock"
    before = path.read_text(encoding="utf-8")

    frozen.release()
    assert path.exists()
    assert path.read_text(encoding="utf-8") == before
    assert a_lock(tmp_path).acquire() is False

    replacement.release()
    assert not path.exists()


def test_a_pass_that_lost_its_lock_stops_refreshing_it(tmp_path):
    """
    The other half of the same rule, at the moment it is discovered.

    A pass proves it is alive before every request. One that has been taken over
    must not keep proving it, because the mtime it would be refreshing is now
    somebody else's claim — the frozen pass would hold a stranger's lock open
    indefinitely and then be entitled to delete it.
    """
    frozen = a_lock(tmp_path, stale_after=0.0)
    assert frozen.acquire()
    assert a_lock(tmp_path, stale_after=0.0).acquire()

    assert frozen.held() is True
    frozen.touch()
    assert frozen.held() is False


def test_a_pass_says_it_is_alive_before_every_request_it_sends(tmp_path):
    """
    What the staleness rule is measured against.

    The refresh rides on `DailyBudget.take`, which is already the one place both
    passes go before a request leaves — the calendar's walk-back reaches it four
    functions down without a parameter of its own.
    """
    held = a_lock(tmp_path)
    assert held.acquire()
    path = tmp_path / "collect.lock"
    long_ago = time.time() - LOCK_STALE_SECONDS - 1
    os.utime(path, (long_ago, long_ago))

    allowance = daily_budget(
        ceiling=600, ledger=RequestLedger(tmp_path / "spend"), now=NOW, lock=held
    )
    allowance.take(kind="board", what="LIM-SCL 2026-10-01")

    assert time.time() - path.stat().st_mtime < LOCK_STALE_SECONDS
    assert a_lock(tmp_path).acquire() is False


# ------------------------------------------------------------- the sweep ----
#
# Day files are the only thing in this feature that is deleted. The archive
# beside them is append-only because it records what the world cost, which
# exists nowhere else once the day passes; these record what we sent.


def test_a_day_file_is_kept_for_ninety_days_and_gone_on_the_ninety_first(tmp_path):
    """
    Ninety days, and what that gives up.

    An old day file answers two questions — what those 600 requests went on, and
    how much this address sent on the day something went wrong — and both are
    about recent behaviour: the cadence table was settled on four days of
    evidence and the 2.43 requests a pair on one. Deleting it deletes the only
    per-request record of that day. What survives is `fares/checks/`, one
    heartbeat per **look**, never pruned, so the shape of an old day is still
    recoverable to within the look-to-request multiplier.
    """
    ledger = RequestLedger(tmp_path / "spend")
    today = date(2026, 8, 21)
    for age in (0, 1, 89, 90, 91, 400):
        ledger.spend(today - timedelta(days=age), kind="board", what="LIM-SCL 2026-10-01")

    assert ledger.prune(today) == 2
    kept = sorted(path.stem for path in (tmp_path / "spend").glob("*.jsonl"))
    # Ninety days back stays; the ninety-first and the one from last year go.
    assert (today - date.fromisoformat(kept[0])).days == 90
    assert kept == ["2026-05-23", "2026-05-24", "2026-08-20", "2026-08-21"]
    assert SPEND_RETENTION_DAYS == 90


def test_the_sweep_runs_when_a_day_opens_and_not_on_every_request(tmp_path):
    """
    Once a day at most, at the only moment the directory grew.

    A scheduled sweep was rejected for the reason the day file itself was chosen
    over a rolling counter: a boundary that needs something run at it is a
    boundary that gets missed. In a real pass this is also inside `PassLock`, so
    nothing has to be said about two processes sweeping at once.
    """
    ledger = RequestLedger(tmp_path / "spend")
    today = date(2026, 8, 21)
    stale = ledger.path_for(today - timedelta(days=200))
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_text("{}\n", encoding="utf-8")

    ledger.spend(today, kind="board", what="LIM-SCL 2026-10-01")
    assert not stale.exists()

    # And a second file put there afterwards survives the rest of the day: the
    # sweep is not something every request pays for.
    stale.write_text("{}\n", encoding="utf-8")
    ledger.spend(today, kind="board", what="LIM-SCL 2026-10-02")
    assert stale.exists()


def test_the_sweep_leaves_alone_what_it_did_not_write(tmp_path):
    """
    Only files whose name parses as a day are deleted.

    Anything else in the directory was put there by somebody else, and a sweep
    that removes what it cannot name is one nobody can leave running unattended.
    """
    ledger = RequestLedger(tmp_path / "spend")
    directory = tmp_path / "spend"
    directory.mkdir(parents=True)
    (directory / "notes.jsonl").write_text("mine\n", encoding="utf-8")
    (directory / "readme.txt").write_text("mine\n", encoding="utf-8")

    assert ledger.prune(date(2026, 8, 21)) == 0
    assert (directory / "notes.jsonl").exists()
    assert (directory / "readme.txt").exists()


def test_the_lock_does_not_live_where_the_sweep_can_reach_it(tmp_path, monkeypatch):
    """
    A lock is not a day, so it is not in the directory of days.

    Put beside `spend/` rather than inside it, because a sweep that walked over
    a live lock would be a collector that let two passes start ninety days after
    the first one it swept.
    """
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
    lock = PassLock()
    assert lock.acquire()
    assert lock.path.parent == RequestLedger().directory.parent
    assert lock.path.parent != RequestLedger().directory
    lock.release()


def test_the_boards_and_the_calendar_keep_their_two_slots(tmp_path, monkeypatch):
    """
    Two locks, because `calendar_job` already decided there are two slots.

    A board pass is minutes long over dozens of departures and a calendar pass
    is two requests. One shared lock would make a route added mid-board-pass go
    without the curve the horizon endpoint exists to fetch immediately — and it
    would not queue for it, it would decline, which is worse than the case that
    decision already rejected. What is closed is each slot across processes.

    The day is safe either way, because only a board pass ever plans a whole
    day: a calendar pass allots one request per window per pair and re-checks
    what is left before every attempt.
    """
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
    boards, calendars = PassLock(), PassLock(name=CALENDAR_LOCK_NAME)

    assert boards.acquire() is True
    assert calendars.acquire() is True
    assert boards.path != calendars.path

    # And each still excludes a second one of its own kind.
    assert PassLock().acquire() is False
    assert PassLock(name=CALENDAR_LOCK_NAME).acquire() is False


def test_a_calendar_pass_runs_beside_a_board_pass(tmp_path):
    """
    The same thing said where a caller would meet it, with no lock handed in.

    `collect_calendars` reaches for its own lock by default, so a board pass
    holding the boards' lock does not turn the horizon endpoint into a refusal.
    """
    boards = PassLock()
    assert boards.acquire()
    curve = read_fixture(CALENDAR_CAPTURE)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=curve)) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03")],
                now=NOW,
                calendar=FareCalendar(tmp_path / "calendar"),
                client=client,
                gap_seconds=0,
                budget=600,
                ledger=RequestLedger(tmp_path / "spend"),
            )

    report = asyncio.run(run())
    assert [result.route for result in report.results] == ["LIM-CUZ"]
    assert report.skipped == []


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


def coming_months(count: int) -> list[str]:
    """
    The next `count` months after this one, `YYYY-MM`.

    Derived rather than written down. The fixtures around this one name a month
    in 2026 and will start reading as departed once the calendar passes it — a
    test that expires quietly is the same class of fault as a scheduled task
    that stops quietly, which is what this group of tests exists to catch.
    """
    today = datetime.now(UTC).date()
    months = []
    year, month = today.year, today.month
    for _ in range(count):
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
        months.append(f"{year}-{month:02d}")
    return months


def test_a_watchlist_written_either_way_becomes_the_same_watches():
    """
    The coexistence pin, and the reason this file may read three shapes forever.

    The browser is the only writer of this document and it rewrites lazily —
    the normalizer takes no clock and edits nothing on load (12.133) — so an
    entry keeps the shape it was last saved in until the reader next touches
    that route. There is no upgrade step that will end it and no deadline to
    set, so the two shapes have to mean exactly the same thing rather than
    nearly.

    `FareWatch` is a frozen slots dataclass, so equality is structural and the
    whole claim is one assertion.
    """
    script = load_collect_script()
    first, second = coming_months(2)

    legacy, legacy_dropped = script.to_watches(
        [
            {"origin": "AEP", "destination": "SCL", "month": first, "currency": "USD"},
            {"origin": "AEP", "destination": "SCL", "month": second, "currency": "USD"},
        ]
    )
    plural, plural_dropped = script.to_watches(
        [{"origin": "AEP", "destination": "SCL", "months": [first, second], "currency": "USD"}]
    )

    assert legacy == plural
    assert legacy_dropped == plural_dropped == []


def test_one_unreadable_month_drops_that_month_and_keeps_the_others():
    """
    The regression that costs a watchlist if the granularity is got wrong.

    The unit of judgement is the month, not the entry. A route naming twelve
    months with a typo in one must keep the other eleven: dropping the entry
    would take eleven watches away for one bad chip, and the reader would see a
    route stop collecting with nothing on screen saying which month did it.
    """
    script = load_collect_script()
    first, second = coming_months(2)

    watches, dropped = script.to_watches(
        [
            {
                "origin": "AEP",
                "destination": "SCL",
                "months": [first, "soon", second],
                "currency": "USD",
            }
        ]
    )

    assert [watch.month for watch in watches] == [first, second]
    assert dropped == ["AEP-SCL soon: unreadable month"]


def test_a_departed_month_beside_a_future_one_drops_only_the_departed_one():
    """
    A stale chip in the strip does not take the live ones with it.

    The route is still worth collecting and says so; the month that has gone is
    named in `dropped` rather than passed over in silence.
    """
    script = load_collect_script()
    (soon,) = coming_months(1)

    watches, dropped = script.to_watches(
        [{"origin": "AEP", "destination": "SCL", "months": ["2020-01", soon], "currency": "USD"}]
    )

    assert [watch.month for watch in watches] == [soon]
    assert dropped == ["AEP-SCL 2020-01: the month is over"]


def test_the_same_month_from_both_shapes_is_watched_once():
    """
    Both shapes can be in one document at once, because the browser rewrites one
    entry at a time. A month arriving from a legacy entry and a plural one is
    one watch, not two: `expand` would collapse the queries anyway, and what
    this protects is the per-watch cost lines the report prints above them.
    """
    script = load_collect_script()
    first, second = coming_months(2)

    watches, dropped = script.to_watches(
        [
            {"origin": "AEP", "destination": "SCL", "month": first, "currency": "USD"},
            {"origin": "AEP", "destination": "SCL", "months": [first, second], "currency": "USD"},
        ]
    )

    assert [watch.month for watch in watches] == [first, second]
    assert dropped == []


def test_an_entry_naming_no_month_at_all_is_named_rather_than_ignored():
    """A route nobody can read a month out of is reported, not silently gone."""
    script = load_collect_script()

    watches, dropped = script.to_watches([{"origin": "AEP", "destination": "SCL"}])

    assert watches == []
    assert dropped == ["AEP-SCL: no departure month"]


@pytest.mark.skipif(
    not (REPO_ROOT / "scripts" / "fares-collect.py").exists(),
    reason="the collector script is not in this checkout",
)
def test_the_scheduled_command_runs_a_whole_dry_pass_over_a_route_with_two_months(tmp_path):
    """
    The gate that makes the plural shape impossible to break silently.

    Sibling of the test below, and it exists because the failure it guards
    against is invisible from every other direction. Read by the old singular
    `route.get("month")`, a `months` array is a truthy list whose `str()` is
    `"['2027-03', '2027-04']"` — `month_dates` refuses it, so every route would
    be dropped as an unreadable month and the whole watchlist would stop
    collecting with a clean exit code, every fifteen minutes, saying nothing.
    That is exactly how this file broke on `focusDate`, for days.

    So it runs the real file, in a subprocess, over the real shape, the way the
    scheduled task runs it.
    """
    first, second = coming_months(2)
    data = tmp_path / "local-data"
    (data / "kv").mkdir(parents=True)
    (data / "kv" / "airfare-routes.json").write_text(
        json.dumps(
            {
                "routes": [
                    {
                        "origin": "AQP",
                        "destination": "LIM",
                        "months": [first, second],
                        "currency": "USD",
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
    # One route, two watchable — the header counts pairs and months, and reading
    # correctly for both is the whole point of the sentence.
    assert "1 route(s), 2 watchable, 0 dropped" in finished.stdout
    assert f"departs in {first}" in finished.stdout
    assert f"departs in {second}" in finished.stdout
    assert "dry run; nothing was fetched" in finished.stdout
    assert not (data / "fares" / "spend").exists()


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


# --------------------------------------------- the scheduler's own window ----


def test_a_pass_that_runs_out_of_window_keeps_the_near_departures_and_says_so(
    tmp_path, monkeypatch
):
    """
    The stop that protects the *next* firing, shaped like the one that protects
    the day.

    The scheduled task is `MultipleInstances = IgnoreNew`, so an invocation
    running past `SCHEDULER_INTERVAL_MINUTES` makes the following one disappear
    with no error and no log — the failure `fares/passes/` exists to make
    visible. A pass that stops at the line and names the rest costs one firing
    nothing; a pass that runs on costs the next one entirely.

    Two things are asserted and the second is the one worth having. It keeps the
    **near** departures, because `collect` is handed its queries nearest-first
    and stopping part way is 12.111 arriving by a third route — the same
    property the budget truncation above relies on. And what it did not send is
    named rather than silently absent: `pass-window-full` beside `over-budget`
    and `not-due`, because a pass that quietly stopped half way is
    indistinguishable from one that found nothing to do (8.8, 8.41).

    The clock is faked rather than slept through. `perf_counter` is called once
    before the loop and once per departure, so a counter advancing a second a
    call puts elapsed time at `index + 1` — a deadline of 2 lets the first
    through and stops the second, deterministically and in no time at all.
    """
    history = FareHistory(tmp_path / "fares")
    page = read_fixture(BOARD)
    sent: list[str] = []

    ticks = iter(range(1000))
    monkeypatch.setattr(fare_collector, "perf_counter", lambda: float(next(ticks)))

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(str(request.url))
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect(
                board_queries()[:5],
                history=history,
                client=client,
                gap_seconds=0,
                budget=daily_budget(ceiling=None, ledger=RequestLedger(tmp_path / "spend")),
                deadline_seconds=2,
            )

    report = asyncio.run(run())

    assert [result.flight_date for result in report.results] == ["2026-10-01"]
    assert report.skipped == [
        ("LIM-SCL 2026-10-02", WINDOW_FULL),
        ("LIM-SCL 2026-10-03", WINDOW_FULL),
        ("LIM-SCL 2026-10-04", WINDOW_FULL),
        ("LIM-SCL 2026-10-05", WINDOW_FULL),
    ]
    # And the ones it declined never left the transport, which is the whole
    # point: a window it reported running out of and then ran past anyway would
    # be worse than no window at all.
    assert len(sent) == 1


def test_a_pass_with_no_deadline_runs_to_the_end_of_its_list(tmp_path, monkeypatch):
    """
    The asymmetry, asserted rather than assumed.

    Only a scheduled pass carries a deadline. A browser press is not on a
    scheduler — its overrun costs a lock the reader chose to hold — and
    truncating it would be answering "I do not believe the last look" with "I
    looked at some of it". Same faked clock, running far past the same line.
    """
    history = FareHistory(tmp_path / "fares")
    page = read_fixture(BOARD)

    ticks = iter(range(1000))
    monkeypatch.setattr(fare_collector, "perf_counter", lambda: float(next(ticks)))

    async def run():
        async with transport(lambda request: httpx.Response(200, text=page)) as client:
            return await collect(
                board_queries()[:5],
                history=history,
                client=client,
                gap_seconds=0,
                budget=daily_budget(ceiling=None, ledger=RequestLedger(tmp_path / "spend")),
            )

    report = asyncio.run(run())
    assert len(report.results) == 5
    assert report.skipped == []


def test_a_window_full_departure_is_counted_as_due_rather_than_as_quiet(tmp_path):
    """
    `due` counts what a pass *wanted*, so the ledger cannot make an overrunning
    pass look like a quiet one.

    `over-budget` was the only skip of that kind; `pass-window-full` is the
    second, and it is the same fact about a different ceiling. If it counted as
    not-due, the one line that would have shown the overrun would report a pass
    with nothing to do.
    """
    recorder = PassRecorder(source="cron", kind="board+calendar", gap=3.0)
    recorder.tally.boards(
        CollectionReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[],
            skipped=[("LIM-SCL 2026-10-02", WINDOW_FULL), ("LIM-SCL 2026-10-03", "not-due")],
        )
    )

    assert recorder.tally.due == 1
    assert recorder.tally.sent == 0
    assert recorder.tally.skipped[WINDOW_FULL] == 1


def test_the_scheduled_command_is_given_the_window_it_has_to_fit_inside(tmp_path, monkeypatch):
    """
    The plumbing, at the one call site that carries a deadline.

    Asserted through the loaded script rather than by reading it, because the
    thing that goes wrong here is an argument that stops being passed — which is
    exactly how this file broke on `focusDate`, and is invisible to every check
    that does not run it.
    """
    script = load_collect_script()
    seen: dict[str, object] = {}

    async def fake_collect_due(watches, **kwargs):
        seen.update(kwargs)
        seen["watched"] = watches
        return CollectionReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[],
            skipped=[],
        )

    monkeypatch.setattr(script, "collect_due", fake_collect_due)
    monkeypatch.setattr(
        script,
        "collect_calendars",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("no calendar in this test")),
    )
    monkeypatch.setattr(script, "load_routes", lambda: [])

    (soon,) = coming_months(1)
    monkeypatch.setattr(
        script,
        "load_routes",
        lambda: [{"origin": "AQP", "destination": "LIM", "months": [soon], "currency": "USD"}],
    )

    args = argparse.Namespace(dry_run=False, all=False, gap=None, no_calendar=True)
    recorder = PassRecorder(source="cron", kind="board", gap=3.0)
    script._pass(args, recorder)

    # It is the scheduler's own interval, and the boards get all of it here
    # because `--no-calendar` means there is no horizon share to subtract.
    assert seen["deadline_seconds"] == SCHEDULER_INTERVAL_MINUTES * 60
