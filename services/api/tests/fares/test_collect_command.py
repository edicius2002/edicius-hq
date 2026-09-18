"""
The command a scheduler would actually invoke, run as a subprocess.

It had raised `TypeError` on its first watch since the focus was removed from
`FareWatch`, and every gate passed anyway — ruff cannot see an argument name and
mypy was not pointed at the repo-root scripts. So this loads and runs the real
`scripts/fares-collect.py` rather than the functions under it.

Out of `test_fares_budget.py`, and nearly autonomous: the script, a temporary
directory and `NOW`. The last test came from the `scheduler's own window`
section, because what it asserts is that this script is handed the deadline —
the same subject as everything else here, and nothing the pass tests need.
"""

import argparse
import importlib.util
import json
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from conftest import NOW

from app.config import SCHEDULER_INTERVAL_MINUTES
from app.services.fare_collector import (
    CalendarReport,
    CalendarResult,
    CollectionReport,
    RouteResult,
)
from app.services.fare_passes import PassLedger, PassRecorder

# Four levels up from `tests/fares/`, not the three this needed as a file in
# `tests/`. The two tests that run the real script skip themselves when they
# cannot find it, so getting this wrong is silent — which is exactly the
# failure this whole file exists to catch.
REPO_ROOT = Path(__file__).resolve().parents[4]

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


def test_load_routes_defaults_to_the_cloud_watch(monkeypatch, tmp_path):
    script = load_collect_script()
    seen = []

    class Cloud:
        def document(self, key):
            seen.append(key)
            return {"routes": []}

    monkeypatch.setattr(script, "configured_collector_cloud", lambda: Cloud())
    monkeypatch.setattr(script, "kv_dir", lambda: tmp_path / "kv")
    assert script.load_routes() == []
    assert seen == ["airfare-routes"]


def test_real_cloud_pass_finishes_a_run_and_closes_the_client(monkeypatch):
    script = load_collect_script()
    cloud = Mock()
    cloud.begin_run.return_value = "run-id"
    recorder = PassRecorder(source="cron", kind="board", gap=0)
    recorder.tally.due = 4
    recorder.tally.sent = 3
    recorder.tally.failed = 1
    args = argparse.Namespace(dry_run=False, watch_source="supabase")

    monkeypatch.setattr(script, "configured_collector_cloud", lambda: cloud)
    monkeypatch.setattr(script, "_pass", lambda _args, _recorder: 0)

    assert script.run_pass(args, recorder) == 0

    cloud.begin_run.assert_called_once_with("airfare")
    cloud.finish_run.assert_called_once_with(
        "run-id", {"seen": 4, "written": 2, "failed": 1}
    )
    cloud.close.assert_called_once_with()


def test_dry_run_and_local_rollback_do_not_create_a_cloud_client(monkeypatch):
    script = load_collect_script()
    configured = Mock()
    monkeypatch.setattr(script, "configured_collector_cloud", configured)
    monkeypatch.setattr(script, "_pass", lambda _args, _recorder: 0)

    for args in (
        argparse.Namespace(dry_run=True, watch_source="supabase"),
        argparse.Namespace(dry_run=False, watch_source="local"),
    ):
        assert script.run_pass(args, PassRecorder(source="cron", kind="board", gap=0)) == 0

    configured.assert_not_called()


def test_real_cloud_pass_marks_failure_with_a_stable_code_and_closes(monkeypatch):
    script = load_collect_script()
    cloud = Mock()
    cloud.begin_run.return_value = "run-id"
    monkeypatch.setattr(script, "configured_collector_cloud", lambda: cloud)
    monkeypatch.setattr(script, "_pass", lambda _args, _recorder: 1)

    assert (
        script.run_pass(
            argparse.Namespace(dry_run=False, watch_source="supabase"),
            PassRecorder(source="cron", kind="board", gap=0),
        )
        == 1
    )

    cloud.fail_run.assert_called_once_with("run-id", "pass-failed")
    cloud.close.assert_called_once_with()


def test_real_cloud_pass_exception_marks_failure_and_closes(monkeypatch):
    script = load_collect_script()
    cloud = Mock()
    cloud.begin_run.return_value = "run-id"
    monkeypatch.setattr(script, "configured_collector_cloud", lambda: cloud)

    def fail(_args, _recorder):
        raise RuntimeError("provider detail must not reach Supabase")

    monkeypatch.setattr(script, "_pass", fail)

    with pytest.raises(RuntimeError, match="provider detail"):
        script.run_pass(
            argparse.Namespace(dry_run=False, watch_source="supabase"),
            PassRecorder(source="cron", kind="board", gap=0),
        )

    cloud.fail_run.assert_called_once_with("run-id", "pass-failed")
    cloud.close.assert_called_once_with()


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
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "fares-collect.py"),
            "--dry-run",
            "--watch-source",
            "local",
        ],
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
        [
            sys.executable,
            str(REPO_ROOT / "scripts" / "fares-collect.py"),
            "--dry-run",
            "--watch-source",
            "local",
        ],
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


def test_the_scheduled_command_syncs_once_only_after_its_successful_local_pass(
    tmp_path, monkeypatch
):
    """The scheduler uses the same façade and never makes a second sync client."""
    script = load_collect_script()
    calls: list[bool] = []
    ledger = PassLedger(tmp_path / "passes")
    (soon,) = coming_months(1)

    async def fake_collect_due(watches, **kwargs):
        return CollectionReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[
                RouteResult(
                    "AQP",
                    "LIM",
                    f"{soon}-01",
                    None,
                    True,
                    changed=False,
                    offers=1,
                    cheapest=123.45,
                    currency="USD",
                )
            ],
        )

    class Facade:
        def sync_incremental(self):
            calls.append(any(ledger.directory.glob("*.jsonl")))
            return SimpleNamespace(status="complete", uploaded={})

    monkeypatch.setattr(script, "collect_due", fake_collect_due)
    monkeypatch.setattr(script, "AIRFARE_DATA", Facade())
    monkeypatch.setattr(script, "airfare_sync_enabled", lambda: True)
    monkeypatch.setattr(
        script,
        "collect_calendars",
        lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("calendar disabled")),
    )
    monkeypatch.setattr(
        script,
        "load_routes",
        lambda: [{"origin": "AQP", "destination": "LIM", "months": [soon], "currency": "USD"}],
    )

    args = argparse.Namespace(dry_run=False, all=False, gap=0, no_calendar=True)
    recorder = PassRecorder(source="cron", kind="board", gap=0, ledger=ledger, now=NOW)

    assert script._pass(args, recorder) == 0
    assert calls == [True]


def test_a_scheduled_dry_run_never_invokes_the_sync_facade(monkeypatch):
    """The preview returns before either collector or its shared replica client exists."""
    script = load_collect_script()
    calls: list[str] = []
    (soon,) = coming_months(1)

    class Facade:
        def sync_incremental(self):
            calls.append("called")
            return SimpleNamespace(status="complete", uploaded={})

    monkeypatch.setattr(script, "AIRFARE_DATA", Facade())
    monkeypatch.setattr(script, "airfare_sync_enabled", lambda: True)
    monkeypatch.setattr(
        script,
        "load_routes",
        lambda: [{"origin": "AQP", "destination": "LIM", "months": [soon], "currency": "USD"}],
    )

    args = argparse.Namespace(dry_run=True, all=False, gap=0, no_calendar=False)
    recorder = PassRecorder(source="cron", kind="board+calendar", gap=0)

    assert script._pass(args, recorder) == 0
    assert calls == []


def test_an_empty_scheduled_pass_never_invokes_the_sync_facade(monkeypatch):
    """An empty watchlist records its local no-op without creating a replica attempt."""
    script = load_collect_script()
    calls: list[str] = []

    class Facade:
        def sync_incremental(self):
            calls.append("called")
            return SimpleNamespace(status="complete", uploaded={})

    monkeypatch.setattr(script, "AIRFARE_DATA", Facade())
    monkeypatch.setattr(script, "airfare_sync_enabled", lambda: True)
    monkeypatch.setattr(script, "load_routes", lambda: [])

    args = argparse.Namespace(dry_run=False, all=False, gap=0, no_calendar=True)
    recorder = PassRecorder(source="cron", kind="board", gap=0)

    assert script._pass(args, recorder) == 0
    assert calls == []


@pytest.mark.parametrize(
    "report",
    [
        CollectionReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[],
            skipped=[],
        ),
        CollectionReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[],
            skipped=[("AQP-LIM 2027-03-01", "not-due")],
        ),
        CollectionReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[RouteResult("AQP", "LIM", "2027-03-01", None, False)],
            skipped=[],
        ),
    ],
)
def test_a_noop_or_refused_scheduled_pass_never_invokes_the_sync_facade(monkeypatch, report):
    """A no-op, cadence decline, or provider refusal has no replica boundary."""
    script = load_collect_script()
    calls: list[str] = []
    (soon,) = coming_months(1)

    async def fake_collect_due(watches, **kwargs):
        return report

    class Facade:
        def sync_incremental(self):
            calls.append("called")
            return SimpleNamespace(status="complete", uploaded={})

    monkeypatch.setattr(script, "collect_due", fake_collect_due)
    monkeypatch.setattr(script, "AIRFARE_DATA", Facade())
    monkeypatch.setattr(script, "airfare_sync_enabled", lambda: True)
    monkeypatch.setattr(
        script,
        "load_routes",
        lambda: [{"origin": "AQP", "destination": "LIM", "months": [soon], "currency": "USD"}],
    )

    args = argparse.Namespace(dry_run=False, all=False, gap=0, no_calendar=True)
    recorder = PassRecorder(source="cron", kind="board", gap=0)

    assert script._pass(args, recorder) == (1 if report.failed else 0)
    assert calls == []


def test_a_sync_disabled_scheduled_pass_never_invokes_the_sync_facade(monkeypatch):
    """The scheduled feature flag is checked before it enters the sync helper."""
    script = load_collect_script()
    calls: list[str] = []
    (soon,) = coming_months(1)

    async def fake_collect_due(watches, **kwargs):
        return CollectionReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[RouteResult("AQP", "LIM", f"{soon}-01", None, True)],
        )

    class Facade:
        def sync_incremental(self):
            calls.append("called")
            return SimpleNamespace(status="complete", uploaded={})

    monkeypatch.setattr(script, "collect_due", fake_collect_due)
    monkeypatch.setattr(script, "AIRFARE_DATA", Facade())
    monkeypatch.setattr(script, "airfare_sync_enabled", lambda: False)
    monkeypatch.setattr(
        script,
        "load_routes",
        lambda: [{"origin": "AQP", "destination": "LIM", "months": [soon], "currency": "USD"}],
    )

    args = argparse.Namespace(dry_run=False, all=False, gap=0, no_calendar=True)
    recorder = PassRecorder(source="cron", kind="board", gap=0)

    assert script._pass(args, recorder) == 0
    assert calls == []


def test_a_board_success_and_calendar_lock_refusal_share_one_scheduled_sync(tmp_path, monkeypatch):
    """A cross-process calendar decline is a completed no-op beside the board write."""
    script = load_collect_script()
    calls: list[bool] = []
    ledger = PassLedger(tmp_path / "passes")
    (soon,) = coming_months(1)

    async def fake_collect_due(watches, **kwargs):
        return CollectionReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[RouteResult("AQP", "LIM", f"{soon}-01", None, True)],
        )

    async def fake_collect_calendars(watches, **kwargs):
        return CalendarReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[],
            skipped=[("AQP-LIM", "another-pass-is-running")],
        )

    class Facade:
        def sync_incremental(self):
            calls.append(any(ledger.directory.glob("*.jsonl")))
            return SimpleNamespace(status="complete", uploaded={})

    monkeypatch.setattr(script, "collect_due", fake_collect_due)
    monkeypatch.setattr(script, "collect_calendars", fake_collect_calendars)
    monkeypatch.setattr(script, "AIRFARE_DATA", Facade())
    monkeypatch.setattr(script, "airfare_sync_enabled", lambda: True)
    monkeypatch.setattr(
        script,
        "load_routes",
        lambda: [{"origin": "AQP", "destination": "LIM", "months": [soon], "currency": "USD"}],
    )

    args = argparse.Namespace(dry_run=False, all=False, gap=0, no_calendar=False)
    recorder = PassRecorder(source="cron", kind="board+calendar", gap=0, ledger=ledger, now=NOW)

    assert script._pass(args, recorder) == 0
    assert calls == [True]


def test_a_board_success_and_calendar_provider_failure_do_not_sync(tmp_path, monkeypatch):
    """A real calendar result failure keeps the combined pass out of the replica."""
    script = load_collect_script()
    calls: list[bool] = []
    ledger = PassLedger(tmp_path / "passes")
    (soon,) = coming_months(1)

    async def fake_collect_due(watches, **kwargs):
        return CollectionReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[RouteResult("AQP", "LIM", f"{soon}-01", None, True)],
        )

    async def fake_collect_calendars(watches, **kwargs):
        return CalendarReport(
            started_at=NOW.isoformat(),
            finished_at=NOW.isoformat(),
            source="google-flights",
            results=[
                CalendarResult(
                    "AQP",
                    "LIM",
                    False,
                    error_code="provider-refused",
                    error_message="test fake only",
                )
            ],
        )

    class Facade:
        def sync_incremental(self):
            calls.append(any(ledger.directory.glob("*.jsonl")))
            return SimpleNamespace(status="complete", uploaded={})

    monkeypatch.setattr(script, "collect_due", fake_collect_due)
    monkeypatch.setattr(script, "collect_calendars", fake_collect_calendars)
    monkeypatch.setattr(script, "AIRFARE_DATA", Facade())
    monkeypatch.setattr(script, "airfare_sync_enabled", lambda: True)
    monkeypatch.setattr(
        script,
        "load_routes",
        lambda: [{"origin": "AQP", "destination": "LIM", "months": [soon], "currency": "USD"}],
    )

    args = argparse.Namespace(dry_run=False, all=False, gap=0, no_calendar=False)
    recorder = PassRecorder(source="cron", kind="board+calendar", gap=0, ledger=ledger, now=NOW)

    assert script._pass(args, recorder) == 0
    assert calls == []
