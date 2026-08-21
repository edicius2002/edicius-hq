"""
The day's spend, read back — `spend-is-read-back-not-only-written`.

`fare_budget` has written a line per request since `a-day-is-what-the-budget-
bounds` and nothing has ever read it except the budget. On a schedule that is
the difference between noticing a runaway pass and finding out because Google
stopped answering, from an address 12.9 says cannot be replaced.

Three of these tests are about the states nobody looks at until they happen: a
day with no file, a day with an empty one, and a ledger that cannot be read at
all. The last is the one that must not be rendered as a quiet morning — the
collector treats it as a day fully spent and stops, so `spent` is `null` and
`remaining` is zero, which are two different things said at once on purpose.

Nothing here touches the network and nothing writes outside `tmp_path`;
`conftest` points `LOCAL_DATA_DIR` at one for every test in the suite.
"""

import json
from datetime import UTC, date, datetime, timedelta

from fastapi.testclient import TestClient

from app.config import BUSIEST_DAY_ON_RECORD, DEFAULT_DAILY_REQUEST_BUDGET, fares_dir
from app.main import app
from app.services.fare_budget import RequestLedger, daily_budget
from app.services.fare_spend import read_spend

client = TestClient(app)

DAY = date(2026, 8, 21)
NOON = datetime(2026, 8, 21, 12, 0, tzinfo=UTC)


def write_ledger(ledger: RequestLedger, day: date, rows: list[dict]) -> None:
    """A day file with exactly these lines in it, written the way the ledger does."""
    path = ledger.path_for(day)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
        encoding="utf-8",
    )


def board(what: str = "LIM-SCL 2026-10-01") -> dict:
    return {"at": "2026-08-21T12:00:00+00:00", "kind": "board", "what": what}


def calendar(what: str = "LIM-CUZ") -> dict:
    return {"at": "2026-08-21T12:00:00+00:00", "kind": "calendar", "what": what}


def today_ledger() -> tuple[RequestLedger, date]:
    """The ledger the endpoint itself will read, and the day it will read."""
    return RequestLedger(), datetime.now(UTC).date()


# ------------------------------------------------------------- the reading --


def test_a_day_is_counted_and_split_by_what_it_went_on(tmp_path):
    """
    The total is the ledger's own count; the split is a second, weaker reading.

    Largest kind first, because the question a reader asks after "how much" is
    "which half of the collector", and boards outnumber calendars by two orders
    of magnitude on the owner's watchlist — 430 against 12.
    """
    ledger = RequestLedger(tmp_path)
    write_ledger(ledger, DAY, [board(), board(), calendar(), board()])

    reading = read_spend(ledger=ledger, ceiling=600, now=NOON)

    assert reading.day == DAY
    assert reading.spent == 4
    assert reading.ceiling == 600
    assert reading.remaining == 596
    assert [(kind.kind, kind.requests) for kind in reading.kinds] == [("board", 3), ("calendar", 1)]


def test_the_day_rolls_over_in_utc_and_says_when(tmp_path):
    """
    The ledger names its file after the **UTC** date, so the roll is not the
    reader's midnight — in Lima it is seven in the evening. A client left to
    work that out from the date alone gets it wrong quietly, so the instant
    travels.
    """
    reading = read_spend(ledger=RequestLedger(tmp_path), ceiling=600, now=NOON)
    assert reading.resets_at == datetime(2026, 8, 22, tzinfo=UTC)

    # And a pass late in the UTC day is still spending against that day, exactly
    # as `daily_budget` fixes it — the two must never name different files.
    late = read_spend(
        ledger=RequestLedger(tmp_path),
        ceiling=600,
        now=datetime(2026, 8, 21, 23, 58, tzinfo=UTC),
    )
    assert late.day == DAY
    assert late.resets_at - datetime(2026, 8, 21, 23, 58, tzinfo=UTC) == timedelta(minutes=2)


def test_what_is_left_is_the_number_the_budget_will_enforce(tmp_path):
    """
    `remaining` mirrors `DailyBudget.remaining` rather than calling it, so this
    is what stops the two drifting. A reader learning a different figure from
    the one the next pass is about to apply would be worse than no figure.
    """
    ledger = RequestLedger(tmp_path)
    write_ledger(ledger, DAY, [board() for _ in range(41)])

    reading = read_spend(ledger=ledger, ceiling=600, now=NOON)
    allowance = daily_budget(ceiling=600, ledger=ledger, now=NOON)

    assert reading.spent == allowance.spent() == 41
    assert reading.remaining == allowance.remaining() == 559


def test_a_day_over_its_ceiling_reports_nothing_left_rather_than_a_negative(tmp_path):
    """
    A ceiling lowered under a day already spent is the ordinary way this
    happens, and `remaining` is what a pass can still buy — which is never less
    than none.
    """
    ledger = RequestLedger(tmp_path)
    write_ledger(ledger, DAY, [board() for _ in range(12)])

    reading = read_spend(ledger=ledger, ceiling=10, now=NOON)
    assert reading.spent == 12
    assert reading.remaining == 0


# --------------------------------------------------- and when there is none --


def test_a_day_with_no_file_and_a_day_with_an_empty_one_are_the_same_nothing(tmp_path):
    """
    Deliberately indistinguishable, because they are the same fact.

    A day nobody has collected on is a file that does not exist yet — that is
    `fare_budget`'s whole reason for a file per day, and there is nothing to run
    at a boundary. Zero requests is zero requests, and inventing a "never
    started" state beside it would be a second empty case for the page to draw.
    """
    missing = read_spend(ledger=RequestLedger(tmp_path / "never-written"), ceiling=600, now=NOON)
    assert missing.spent == 0
    assert missing.remaining == 600
    assert missing.kinds == ()

    ledger = RequestLedger(tmp_path)
    write_ledger(ledger, DAY, [])
    empty = read_spend(ledger=ledger, ceiling=600, now=NOON)
    assert empty.spent == 0
    assert empty.remaining == 600
    assert empty.kinds == ()


def test_a_ledger_that_cannot_be_read_is_not_a_quiet_day(tmp_path):
    """
    `spent` is `None` and `remaining` is zero, and both are true at once.

    The collector fails closed on this — an unreadable day is treated as fully
    spent, every departure comes back `over-budget` and nothing collects until
    it can be read. A reader shown `0` would be looking at a stopped collector
    and reading it as a quiet morning, which is the worst available answer.
    """
    ledger = RequestLedger(tmp_path)
    # A directory where the day's file should be: `exists()` is true and
    # `read_text` is not going to work — the same trick `test_fares_budget` uses.
    ledger.path_for(DAY).mkdir(parents=True)

    reading = read_spend(ledger=ledger, ceiling=600, now=NOON)
    assert reading.spent is None
    assert reading.remaining == 0
    assert reading.kinds == ()

    # And it agrees with what the budget will actually do.
    assert daily_budget(ceiling=600, ledger=ledger, now=NOON).remaining() == 0


def test_a_line_a_crash_cut_in_half_is_counted_and_not_attributed(tmp_path):
    """
    The total is lines and the split is parsed JSON, so they can disagree by the
    one line a crash interrupted — and the total is the one that wins.

    That is the arrangement rather than a defect. `RequestLedger.spent` counts
    lines precisely because a half-written line is still a request that left
    this address, and a breakdown that made the total smaller to keep its own
    arithmetic tidy would under-count the thing the budget protects.
    """
    ledger = RequestLedger(tmp_path)
    path = ledger.path_for(DAY)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(board()) + "\n" + json.dumps(calendar()) + "\n" + '{"at": "2026-08-2',
        encoding="utf-8",
    )

    reading = read_spend(ledger=ledger, ceiling=600, now=NOON)
    assert reading.spent == 3
    assert sum(kind.requests for kind in reading.kinds) == 2


def test_a_kind_this_build_does_not_know_is_shown_rather_than_refused(tmp_path):
    """
    The file is an archive of what was written on the day, not a schema this
    build gets to enforce. A word from an older or newer collector is a thing to
    put on screen; raising on it would make a reading of the past fail because
    the present changed.
    """
    ledger = RequestLedger(tmp_path)
    write_ledger(ledger, DAY, [{"at": "…", "kind": "seat-map", "what": "LIM-SCL"}, board()])

    reading = read_spend(ledger=ledger, ceiling=600, now=NOON)
    assert [(kind.kind, kind.requests) for kind in reading.kinds] == [
        ("board", 1),
        ("seat-map", 1),
    ]


# ---------------------------------------------------------------- the wire --


def test_the_endpoint_answers_the_day_the_ceiling_and_the_busiest_real_day(tmp_path):
    ledger, day = today_ledger()
    write_ledger(ledger, day, [board(), calendar(), calendar()])

    response = client.get("/api/fares/spend")
    assert response.status_code == 200
    body = response.json()

    assert body["day"] == day.isoformat()
    assert body["resetsAt"].startswith((day + timedelta(days=1)).isoformat())
    assert body["spent"] == 3
    assert body["ceiling"] == DEFAULT_DAILY_REQUEST_BUDGET
    assert body["remaining"] == DEFAULT_DAILY_REQUEST_BUDGET - 3
    assert body["kinds"] == [
        {"kind": "calendar", "requests": 2},
        {"kind": "board", "requests": 1},
    ]

    # The measured high-water mark travels with the ceiling, and is what stops a
    # bar filling towards 600 from reading as a fraction of a safe maximum. 600
    # is a judgement — `config.py` says so — and 329 is the only number in the
    # pair anything measured.
    assert body["busiestOnRecord"] == BUSIEST_DAY_ON_RECORD == 329
    assert body["busiestOnRecord"] < body["ceiling"]


def test_the_endpoint_says_nothing_rather_than_zero_when_the_ledger_will_not_open(tmp_path):
    ledger, day = today_ledger()
    ledger.path_for(day).mkdir(parents=True)

    body = client.get("/api/fares/spend").json()
    assert body["spent"] is None
    assert body["remaining"] == 0
    assert body["kinds"] == []


def test_the_endpoint_answers_a_first_run_with_zero_rather_than_a_404(tmp_path):
    """
    A machine that has collected nothing today is the ordinary state of this
    endpoint — the first run of the day, every day — and 404 would make the
    client special-case an error for it. The same argument `IDLE` makes for
    `GET /collect`.
    """
    body = client.get("/api/fares/spend").json()
    assert body["spent"] == 0
    assert body["remaining"] == DEFAULT_DAILY_REQUEST_BUDGET
    assert body["kinds"] == []
    assert not (fares_dir() / "spend").exists()


def test_the_ceiling_on_the_wire_is_the_one_the_collector_will_use(monkeypatch):
    """
    `FARES_DAILY_REQUEST_BUDGET` overrides the default, and the page must be
    reading the same number the next pass will enforce rather than the built-in.
    """
    monkeypatch.setenv("FARES_DAILY_REQUEST_BUDGET", "120")
    body = client.get("/api/fares/spend").json()
    assert body["ceiling"] == 120
    assert body["remaining"] == 120
