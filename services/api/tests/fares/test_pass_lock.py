"""
One pass at a time, the sweep that clears a dead one, and the scheduler's window.

The lock beside the ledger in `test_budget_ledger.py`: two passes must not
spend the same day twice, a forced press has to meet both of them, and a lock
left behind by a process that died has to age out rather than wedge the
collector forever.

The scheduler's own window is here rather than with the command in
`test_collect_command.py` because it needs this file's whole preamble — a real
pass against a fixture board. The one test in that section that asserts on the
*script* being handed the window went the other way, to sit with the rest of
the loaded-script tests: reading it showed the section was two subjects rather
than one.

Nothing here touches the network.
"""

import asyncio
import os
import time
from datetime import date, timedelta

import httpx
import pytest
from conftest import BOARD, CALENDAR_CAPTURE, NOW, TODAY, board_queries, read_fixture, transport

from app.config import SPEND_RETENTION_DAYS
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
