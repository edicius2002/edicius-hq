"""Exercise the Pi SEACE entrypoint's source selection without live SEACE."""

import importlib.util
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest


@pytest.fixture
def command(monkeypatch):
    monkeypatch.setitem(
        sys.modules, "fcntl", SimpleNamespace(LOCK_EX=2, LOCK_NB=4, flock=lambda *_: None)
    )
    path = Path(__file__).resolve().parents[3] / "scripts/seace-collect.py"
    spec = importlib.util.spec_from_file_location("seace_collect_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_run_pass_sends_scope_to_collector(command, monkeypatch):
    scopes = []

    async def refresh(region, year, *, publisher, kinds):
        scopes.append(kinds)
        return {kind: {"total": 1} for kind in kinds}

    cloud = SimpleNamespace(
        begin_run=lambda *_: "run",
        finish_run=lambda *_: None,
        fail_run=lambda *_: pytest.fail("unexpected failure"),
    )
    monkeypatch.setattr(command, "refresh_region", refresh)
    command.run_pass(cloud, "Arequipa", 2026, scope="notices")
    command.run_pass(cloud, "Arequipa", 2026, scope="core")
    command.run_pass(cloud, "Arequipa", 2026)
    assert scopes == [
        ("notices",),
        ("processes", "contracts"),
        ("notices", "processes", "contracts"),
    ]


def test_notice_schedule_skips_active_cooldown_before_cloud_connection(
    command, monkeypatch, tmp_path
):
    (tmp_path / "prod6-cooldown-until").write_text(str(time.time() + 600), encoding="ascii")
    monkeypatch.setenv("SEACE_STATE_DIR", str(tmp_path))
    monkeypatch.setattr(
        sys, "argv", ["seace-collect.py", "--mode", "scheduled", "--scope", "notices"]
    )
    monkeypatch.setattr(command, "CollectorCloud", lambda *_: pytest.fail("cloud opened"))
    assert command.main() == 0


def test_manual_refresh_rejects_partial_scope(command, monkeypatch):
    monkeypatch.setattr(
        sys, "argv", ["seace-collect.py", "--mode", "requests", "--scope", "notices"]
    )
    with pytest.raises(SystemExit) as caught:
        command.main()
    assert caught.value.code == 2
