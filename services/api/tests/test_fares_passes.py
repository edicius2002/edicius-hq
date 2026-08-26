"""
Every pass leaves a line, and the ones that sent nothing leave it too.

**The measurement that asked for this.** Over 105 scheduled firings, 6 sent
something and 99 did not — and a pass that sends nothing wrote nothing
anywhere, so 94% of what the collector did was invisible. The fallback the
comment in `scripts/fares-collect.py` named was the Task Scheduler's own
history, and on this machine that log is disabled, which was found out by
looking rather than by assuming. So there was no record of a firing at all: not
of the ones that did nothing, not of the interval between them, and not of how
long any of them took.

Three of these tests are about the three things that had no record:

- **The no-op.** A pass whose whole answer is `154 not-due` writes exactly the
  same line as one that collected, with zeroes in it. That is the line that
  makes the interval countable, because ninety-six of them a day are what
  ninety-six firings look like.
- **The duration.** The scheduled task is `MultipleInstances = IgnoreNew` at
  fifteen minutes, so a pass that runs past fifteen minutes makes the next one
  vanish silently. The longest observed pass is 4m38s at the current gap; at
  3.0s a full watchlist is ~9.8 minutes and a near month would overrun. `wallMs`
  is the only figure that would ever show that happening.
- **The gap.** The pace a pass ran at was nowhere on disk, so telling a 1.75s
  population from a 3.0s one meant inferring it from the modal delta between
  request timestamps. `gap` on the line, and on every spend line the pass wrote,
  turns that inference into a read.

Nothing here touches the network: the one test that runs the real command line
runs it against an empty watchlist, which returns before a client exists.
"""

import json
import os
import subprocess
import sys
import time
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import SPEND_RETENTION_DAYS, fares_dir
from app.main import app
from app.services import calendar_job, collection_job
from app.services.fare_collector import (
    CalendarReport,
    CalendarResult,
    CollectionReport,
    RouteResult,
)
from app.services.fare_passes import PassLedger, PassRecorder, PassTally, new_pass_id

REPO_ROOT = Path(__file__).resolve().parents[3]

NOON = datetime(2026, 8, 21, 12, 0, tzinfo=UTC)
DAY = NOON.date()


def lines(ledger: PassLedger, day: date) -> list[dict]:
    """Every line of a day's pass ledger, parsed."""
    text = ledger.path_for(day).read_text(encoding="utf-8")
    return [json.loads(line) for line in text.splitlines() if line.strip()]


def a_ticking_clock(*readings: float):
    """A monotonic clock that answers each reading once, in order."""
    remaining = list(readings)
    return lambda: remaining.pop(0) if len(remaining) > 1 else remaining[0]


def boards(results: list[RouteResult], skipped: list[tuple[str, str]]) -> CollectionReport:
    return CollectionReport(
        started_at=NOON.isoformat(),
        finished_at=NOON.isoformat(),
        source="gflights",
        results=results,
        skipped=skipped,
    )


def looked_at(day: str = "2026-10-01", *, ok: bool = True) -> RouteResult:
    return RouteResult(
        origin="LIM",
        destination="SCL",
        flight_date=day,
        return_date=None,
        ok=ok,
        error_code=None if ok else "parse-failed",
    )


# ------------------------------------------------------ the line that is left --


def test_a_pass_that_sent_nothing_still_writes_a_line(tmp_path):
    """
    Ninety-nine of a hundred and five passes did nothing and said nothing.

    This is the whole point of the file: `due` and `sent` at zero with the
    reasons counted beside them is a *record*, where silence is not. A reader
    counting lines in a day file is counting firings, which is the only way the
    fifteen-minute interval can be checked against what actually happened.
    """
    ledger = PassLedger(tmp_path / "passes")
    recorder = PassRecorder(
        source="cron",
        kind="board+calendar",
        gap=1.75,
        pass_id="0123456789ab",
        ledger=ledger,
        now=NOON,
        clock=a_ticking_clock(10.0, 10.86),
    )
    recorder.tally.boards(boards([], [("LIM-SCL 2026-10-01", "not-due")] * 154))
    recorder.finish(exit_code=0)

    assert lines(ledger, DAY) == [
        {
            "at": "2026-08-21T12:00:00+00:00",
            "passId": "0123456789ab",
            "source": "cron",
            "kind": "board+calendar",
            "gap": 1.75,
            "due": 0,
            "sent": 0,
            "skipped": {"not-due": 154},
            "failed": 0,
            "wallMs": 860,
            "exit": 0,
        }
    ]


def test_the_line_says_when_the_pass_started_rather_than_when_it_ended(tmp_path):
    """
    `at` is the start, and `wallMs` is how far past it the pass ran.

    The question the file exists to answer is whether the firings are fifteen
    minutes apart, and that is a question about when passes *begin*. An end
    timestamp would put the drift and the duration in one number and make
    neither recoverable. It also fixes which day file a pass belongs to: one
    that starts at 23:59 is written to the day it started in, so a pass is
    never split across two files.
    """
    ledger = PassLedger(tmp_path / "passes")
    late = datetime(2026, 8, 21, 23, 59, 30, tzinfo=UTC)
    recorder = PassRecorder(
        source="cron",
        kind="board",
        gap=3.0,
        ledger=ledger,
        now=late,
        clock=a_ticking_clock(0.0, 600.0),
    )
    recorder.finish(exit_code=0)

    [row] = lines(ledger, date(2026, 8, 21))
    assert row["at"] == "2026-08-21T23:59:30+00:00"
    assert row["wallMs"] == 600_000
    assert not (tmp_path / "passes" / "2026-08-22.jsonl").exists()


def test_a_pass_long_enough_to_lose_the_next_one_is_visible_as_a_number(tmp_path):
    """
    The failure with no symptom: `IgnoreNew` at fifteen minutes.

    The scheduled task drops a firing that arrives while the previous one is
    still running, and it drops it without a word. At the measured 2.43 requests
    a pair and a 3.0s gap a full watchlist pass is about 9.8 minutes, so a near
    month is what would push one past the interval — and the first sign would be
    a collector that was quietly running half as often. `wallMs` is what a
    reader can sort a day's lines by.
    """
    ledger = PassLedger(tmp_path / "passes")
    recorder = PassRecorder(
        source="cron",
        kind="board+calendar",
        gap=3.0,
        ledger=ledger,
        now=NOON,
        clock=a_ticking_clock(0.0, 16 * 60.0),
    )
    recorder.tally.boards(boards([looked_at()], []))
    recorder.finish(exit_code=0)

    [row] = lines(ledger, DAY)
    assert row["wallMs"] > 15 * 60 * 1000


def test_a_pass_that_fell_over_leaves_the_same_line(tmp_path):
    """
    An exception is an ending, and an ending is a line.

    A pass that raised used to be the same silence as a pass that did nothing.
    `exit` separates them: it is the process's code from the command line and
    the same 0-or-1 for a pass with no process, so one field answers "did this
    end badly" whichever origin wrote it.
    """
    ledger = PassLedger(tmp_path / "passes")
    recorder = PassRecorder(
        source="ui", kind="board", gap=3.0, ledger=ledger, now=NOON, clock=a_ticking_clock(0.0, 1.5)
    )
    try:
        raise RuntimeError("the upstream went away")
    except RuntimeError:
        recorder.tally.boards(boards([looked_at()], []))
        recorder.finish(exit_code=1)

    [row] = lines(ledger, DAY)
    assert row["exit"] == 1
    # And what it managed before it fell over is still on the line.
    assert (row["sent"], row["failed"]) == (1, 0)


def test_the_two_origins_are_told_apart_by_name(tmp_path):
    """
    `cron` is the scheduled command line and `ui` is a press on the page.

    They are the two things that can start a pass and they behave differently —
    one runs every fifteen minutes unattended, the other arrives whenever
    somebody is looking — so a day's lines are only comparable once they can be
    separated. A human running the command by hand is recorded as `cron` too,
    because what the line can honestly say is which code path ran and not who
    asked for it.
    """
    ledger = PassLedger(tmp_path / "passes")
    for source in ("cron", "ui"):
        PassRecorder(
            source=source, kind="board", gap=3.0, ledger=ledger, now=NOON, clock=lambda: 0.0
        ).finish(exit_code=0)

    assert [row["source"] for row in lines(ledger, DAY)] == ["cron", "ui"]


def test_every_pass_line_carries_an_identifier_of_its_own(tmp_path):
    """
    The join between a pass and the requests it sent.

    A pass id on both ledgers is what turns "which of these 952 spend lines
    belong to the 21:00 pass" from a question about timestamps into a lookup.
    Short enough that it costs a fifth of a spend line and long enough that a
    day of ninety-six passes will not collide.
    """
    minted = {new_pass_id() for _ in range(1000)}
    assert len(minted) == 1000
    assert all(len(one) == 12 and one.isalnum() for one in minted)


# --------------------------------------------------------------- the tally --


def test_boards_and_the_horizon_are_one_line_from_one_invocation(tmp_path):
    """
    One scheduled command is one pass, whatever it ran inside itself.

    The command collects boards and then the horizon, and the thing that has to
    fit inside fifteen minutes is the *invocation* rather than either loop, so
    the two are tallied together and `kind` says which of them ran. The units
    differ — departures for the boards, city pairs for the horizon — and `sent`
    is what reconciles them: it counts requests, which is what the day's ledger
    counts and what the address is actually judged on.
    """
    tally = PassTally()
    tally.boards(boards([looked_at("2026-10-01"), looked_at("2026-10-02", ok=False)], []))
    tally.calendars(
        CalendarReport(
            started_at=NOON.isoformat(),
            finished_at=NOON.isoformat(),
            source="gflights",
            results=[CalendarResult(origin="LIM", destination="CUZ", ok=True, requests=3)],
            skipped=[("SCL-EZE", "not-due")],
        )
    )

    # Two departures and one city pair looked at; two board requests and three
    # calendar requests sent, because a refused far end is walked back (12.245).
    assert (tally.due, tally.sent, tally.failed) == (3, 5, 1)
    assert dict(tally.skipped) == {"not-due": 1}


def test_a_departure_the_day_could_not_afford_was_still_due(tmp_path):
    """
    `over-budget` is "it was due and we could not send it", so it counts as due.

    Every other skip is the pass deciding there was nothing to ask for. This one
    is the pass wanting to ask and being stopped, which is the difference
    between a quiet watchlist and a truncated day — and `due` minus `sent` is
    where a reader would see it.
    """
    tally = PassTally()
    tally.boards(
        boards(
            [looked_at("2026-10-01")],
            [("LIM-SCL 2026-10-02", "over-budget"), ("LIM-SCL 2026-11-01", "not-due")],
        )
    )

    assert (tally.due, tally.sent) == (2, 1)
    assert dict(tally.skipped) == {"over-budget": 1, "not-due": 1}


def test_the_reasons_are_counted_as_they_were_written_and_not_padded(tmp_path):
    """
    Only the reasons that happened, spelled the way the collector spells them.

    The suggested shape carried three fixed keys at zero. It is not taken,
    because the vocabulary is not fixed: `unreadable-month`, `departed`,
    `past-horizon` and `another-pass-is-running` all appear, and a writer that
    padded three of them would be claiming a closed set the collector does not
    have. `fare_spend` makes the same argument about `kind` — what the ledger
    holds is whatever was written on the day, and a reader of an old file should
    meet a word it does not know rather than a missing one it trusted.
    """
    ledger = PassLedger(tmp_path / "passes")
    recorder = PassRecorder(
        source="cron", kind="board", gap=3.0, ledger=ledger, now=NOON, clock=lambda: 0.0
    )
    recorder.tally.boards(
        boards([], [("LIM-SCL 2026-09", "unreadable-month"), ("LIM-SCL 2026-10-01", "departed")])
    )
    recorder.finish(exit_code=0)

    [row] = lines(ledger, DAY)
    assert row["skipped"] == {"departed": 1, "unreadable-month": 1}


def test_a_declined_pass_is_a_line_saying_it_was_declined(tmp_path):
    """
    Being second is not a failure, and it is not nothing either.

    A cron firing while the owner presses Collect reports every departure as
    `another-pass-is-running` and exits 0. That pass sent nothing, so before
    this it wrote nothing — and a day where the schedule and a reader kept
    colliding looked exactly like a day where the schedule ran alone.
    """
    ledger = PassLedger(tmp_path / "passes")
    recorder = PassRecorder(
        source="cron", kind="board", gap=3.0, ledger=ledger, now=NOON, clock=lambda: 0.0
    )
    recorder.tally.boards(boards([], [("LIM-SCL 2026-10-01", "another-pass-is-running")] * 31))
    recorder.finish(exit_code=0)

    [row] = lines(ledger, DAY)
    assert row["skipped"] == {"another-pass-is-running": 31}
    assert row["exit"] == 0


# ------------------------------------------------------------- the sweep ----


def test_a_day_of_passes_is_kept_for_the_same_ninety_days_as_the_spend(tmp_path):
    """
    One retention rule, not two, and the existing one.

    A day of passes is about 96 lines and 15 KB, so nothing here is a disk
    argument — it is the same judgement `config.py` records for the spend
    ledger: the questions an old pass line answers are about recent behaviour,
    and a quarter is more history than any decision in this feature has wanted.
    Two different numbers would mean a spend line whose pass had been swept, and
    the join between the ledgers would rot at whichever boundary came first.
    """
    ledger = PassLedger(tmp_path / "passes")
    today = date(2026, 8, 21)
    for age in (0, 1, 89, 90, 91, 400):
        PassRecorder(
            source="cron",
            kind="board",
            gap=3.0,
            ledger=ledger,
            now=datetime.combine(today - timedelta(days=age), datetime.min.time(), tzinfo=UTC),
            clock=lambda: 0.0,
        ).finish(exit_code=0)

    assert ledger.prune(today) == 2
    kept = sorted(path.stem for path in (tmp_path / "passes").glob("*.jsonl"))
    assert kept == ["2026-05-23", "2026-05-24", "2026-08-20", "2026-08-21"]
    assert SPEND_RETENTION_DAYS == 90


def test_the_sweep_runs_when_a_day_opens_and_not_on_every_pass(tmp_path):
    """
    Once a day at most, at the only moment the directory grew.

    The same mechanism the spend ledger uses, called from the same place in the
    same way: a boundary that needs something run at it is a boundary that gets
    missed, and ninety-six passes a day must not each pay for a sweep.
    """
    ledger = PassLedger(tmp_path / "passes")
    today = date(2026, 8, 21)
    stale = ledger.path_for(today - timedelta(days=200))
    stale.parent.mkdir(parents=True, exist_ok=True)
    stale.write_text("{}\n", encoding="utf-8")

    def a_pass() -> None:
        PassRecorder(
            source="cron",
            kind="board",
            gap=3.0,
            ledger=ledger,
            now=datetime.combine(today, datetime.min.time(), tzinfo=UTC),
            clock=lambda: 0.0,
        ).finish(exit_code=0)

    a_pass()
    assert not stale.exists()

    stale.write_text("{}\n", encoding="utf-8")
    a_pass()
    assert stale.exists()


def test_the_sweep_leaves_alone_what_it_did_not_write(tmp_path):
    """Only files whose name parses as a day, the same rule as the spend sweep."""
    ledger = PassLedger(tmp_path / "passes")
    directory = tmp_path / "passes"
    directory.mkdir(parents=True)
    (directory / "notes.jsonl").write_text("mine\n", encoding="utf-8")

    assert ledger.prune(date(2026, 8, 21)) == 0
    assert (directory / "notes.jsonl").exists()


def test_a_ledger_that_cannot_be_written_does_not_stop_a_pass(tmp_path):
    """
    The record is worth less than the collection it records.

    Same rule as the spend ledger: a failed append costs the line and never the
    pass. This is instrumentation, and instrumentation that can end a pass is a
    new way for the collector to fail.
    """
    directory = tmp_path / "passes"
    directory.write_text("not a directory\n", encoding="utf-8")

    PassRecorder(
        source="cron",
        kind="board",
        gap=3.0,
        ledger=PassLedger(directory),
        now=NOON,
        clock=lambda: 0.0,
    ).finish(exit_code=0)


# ------------------------------------------------------ the press's own line --


@pytest.fixture
def an_empty_runner():
    """One pass slot serves the whole process, so it is emptied around a test."""
    collection_job.RUNNER.forget()
    calendar_job.CALENDAR_RUNNER.forget()
    yield
    collection_job.RUNNER.forget()
    calendar_job.CALENDAR_RUNNER.forget()


def wait_for(client, path: str, timeout: float = 5.0) -> dict:
    """Poll a pass document until it stops running — a press is answered early."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        body = client.get(path).json()
        if body["state"] != "running":
            return body
        time.sleep(0.01)
    raise AssertionError(f"the pass at {path} never finished")


def today_lines() -> list[dict]:
    """The pass ledger the app itself writes, which `conftest` puts in `tmp_path`."""
    path = fares_dir() / "passes" / f"{datetime.now(UTC).date().isoformat()}.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]


def test_a_press_on_the_page_leaves_a_line_of_its_own(monkeypatch, an_empty_runner):
    """
    The second origin, and the reason `source` exists.

    A press and a scheduled firing are both passes and they are not comparable:
    one arrives when somebody is looking and the other every fifteen minutes
    with nobody watching. Averaging them would make the interval this file
    exists to measure unreadable, so the runner names itself `ui` and the
    command line names itself `cron`.
    """
    collected = RouteResult(
        origin="LIM", destination="SCL", flight_date="2027-03-01", return_date=None, ok=True
    )

    async def fake_collect_due(watched, **kwargs):
        observer = kwargs.get("observer")
        assert kwargs.get("pass_id"), "the pass's id has to reach the requests it sends"
        if observer is not None:
            observer.planned(polling=1, skipped=[("LIM-SCL 2027-03-02", "not-due")])
            observer.collected(collected)
        return CollectionReport(
            started_at="2027-01-01T00:00:00+00:00",
            finished_at="2027-01-01T00:00:06+00:00",
            source="google-flights",
            results=[collected],
            skipped=[("LIM-SCL 2027-03-02", "not-due")],
        )

    monkeypatch.setattr(collection_job, "collect_due", fake_collect_due)

    with TestClient(app) as client:
        client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        finished = wait_for(client, "/api/fares/collect")

    assert finished["state"] == "finished"
    [row] = today_lines()
    assert row["source"] == "ui"
    assert row["kind"] == "board"
    assert (row["due"], row["sent"], row["failed"], row["exit"]) == (1, 1, 0, 0)
    assert row["skipped"] == {"not-due": 1}
    assert row["gap"] > 0


def test_a_press_that_fell_over_says_so_on_its_line(monkeypatch, an_empty_runner):
    """
    A runner's task that raised has no exit code, so it is given one.

    The pass is already marked `failed` for the browser; what had no record was
    the *machine's* view of it. `exit` at 1 puts a crashed press and a crashed
    scheduled pass in the same column, which is what makes a day's file
    sortable.
    """

    async def falls_over(watched, **kwargs):
        raise RuntimeError("the upstream went away")

    monkeypatch.setattr(collection_job, "collect_due", falls_over)

    with TestClient(app) as client:
        client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        finished = wait_for(client, "/api/fares/collect")

    assert finished["state"] == "failed"
    [row] = today_lines()
    assert (row["source"], row["exit"], row["sent"]) == ("ui", 1, 0)


def test_the_horizon_pass_leaves_its_own_line_and_names_itself(monkeypatch, an_empty_runner):
    """
    A curve press is its own pass, where the scheduled command's two are one.

    The command runs boards and then the horizon in one process and one line,
    because what has to fit inside the scheduler's fifteen minutes is the
    invocation. A press on this endpoint is a whole pass on its own, so `kind`
    is what tells the two apart in a day's file.
    """

    async def fake_collect_calendars(watched, **kwargs):
        assert kwargs.get("pass_id"), "the pass's id has to reach the requests it sends"
        return CalendarReport(
            started_at="2027-01-01T00:00:00+00:00",
            finished_at="2027-01-01T00:00:20+00:00",
            source="google-flights",
            results=[CalendarResult(origin="LIM", destination="CUZ", ok=True, requests=3)],
            skipped=[],
        )

    monkeypatch.setattr(calendar_job, "collect_calendars", fake_collect_calendars)

    with TestClient(app) as client:
        client.post("/api/fares/calendar/collect", json={"origin": "LIM", "destination": "CUZ"})
        finished = wait_for(client, "/api/fares/calendar/collect")

    assert finished["state"] == "finished"
    [row] = today_lines()
    assert row["kind"] == "calendar"
    # Three requests for one pair, because a refused far end is walked back.
    assert (row["source"], row["due"], row["sent"]) == ("ui", 1, 3)


# --------------------------------------------------- the command line's own --


def test_the_scheduled_command_writes_its_line_when_there_is_nothing_to_do(tmp_path):
    """
    The command line is the origin that was invisible, so it is run for real.

    An empty watchlist returns before a client exists, so this reaches nothing —
    and it is exactly the shape of the 99 firings that wrote nothing: a pass
    with no work. It now leaves a line saying so, from `cron`, with a duration.
    """
    data = tmp_path / "local-data"
    (data / "kv").mkdir(parents=True)

    finished = subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / "fares-collect.py")],
        capture_output=True,
        text=True,
        env={**os.environ, "LOCAL_DATA_DIR": str(data)},
        cwd=str(REPO_ROOT / "services" / "api"),
        timeout=120,
    )

    assert finished.returncode == 0, finished.stderr
    assert "nothing to do" in finished.stdout
    [path] = sorted((data / "fares" / "passes").glob("*.jsonl"))
    [row] = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line]
    assert row["source"] == "cron"
    assert (row["due"], row["sent"], row["failed"], row["exit"]) == (0, 0, 0, 0)
    assert row["gap"] > 0
    assert row["wallMs"] >= 0
    # Nothing was sent, so nothing was spent: the two ledgers agree about a pass
    # that did nothing, which is the pairing the whole exercise is for.
    assert not (data / "fares" / "spend").exists()


def test_a_dry_run_is_not_a_pass_and_leaves_no_line(tmp_path):
    """
    `--dry-run` returns before any fetch, and a person is watching it.

    It is excluded on purpose: it sends nothing, it is never what the scheduler
    invokes, and a line from it would sit in the same file as the ninety-six
    real ones with a duration that measures printing rather than collecting.
    The existing rule for it is "reaching nothing means writing nothing", and
    this keeps the new ledger inside that rule.
    """
    data = tmp_path / "local-data"
    (data / "kv").mkdir(parents=True)
    (data / "kv" / "airfare-routes.json").write_text(
        json.dumps({"routes": [{"origin": "AQP", "destination": "LIM", "month": "2027-11"}]}),
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
    assert "dry run; nothing was fetched" in finished.stdout
    assert not (data / "fares" / "passes").exists()
    assert not (data / "fares" / "spend").exists()
