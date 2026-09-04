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

import pytest
from conftest import NOW

from app.config import SCHEDULER_INTERVAL_MINUTES
from app.services.fare_collector import (
    CollectionReport,
)
from app.services.fare_passes import PassRecorder

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
