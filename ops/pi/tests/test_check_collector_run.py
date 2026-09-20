"""Behavior checks for the owner-scoped collector health query."""

from __future__ import annotations

import importlib.util
from datetime import UTC, datetime
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "check-collector-run.py"


def load_script():
    spec = importlib.util.spec_from_file_location("check_collector_run", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_oneshot_query_requires_a_fresh_start_and_exact_complete_status() -> None:
    module = load_script()
    cutoff = datetime(2026, 9, 18, 12, tzinfo=UTC)

    params = module.run_query_params("owner", "sentiment", cutoff, require_complete=True)

    assert params["started_at"] == "gte.2026-09-18T12:00:00+00:00"
    assert "heartbeat_at" not in params
    assert module.is_healthy_status("complete", require_complete=True)
    assert not module.is_healthy_status("running", require_complete=True)


def test_worker_query_requires_a_fresh_heartbeat_and_exact_running_status() -> None:
    module = load_script()
    cutoff = datetime(2026, 9, 18, 12, tzinfo=UTC)

    params = module.run_query_params("owner", "market", cutoff, require_complete=False)

    assert params["heartbeat_at"] == "gte.2026-09-18T12:00:00+00:00"
    assert "started_at" not in params
    assert module.is_healthy_status("running", require_complete=False)
    assert not module.is_healthy_status("complete", require_complete=False)
