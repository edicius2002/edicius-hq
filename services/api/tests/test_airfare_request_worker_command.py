from __future__ import annotations

import asyncio
import importlib.util
import sys
import uuid
from pathlib import Path
from types import ModuleType
from unittest.mock import AsyncMock, Mock

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "airfare-request-worker.py"


def load_script() -> ModuleType:
    name = f"airfare_request_worker_script_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_run_worker_uses_distinct_health_and_closes_cloud():
    cloud = Mock()

    async def run(_stopped, cycle_completed):
        cycle_completed({"seen": 1, "written": 1, "failed": 0})

    worker = Mock(run=AsyncMock(side_effect=run))
    worker.run_records = {"seen": 1, "written": 1, "failed": 0}

    assert asyncio.run(load_script().run_worker(cloud, worker, asyncio.Event())) == 0

    cloud.begin_run.assert_called_once_with("airfare-requests")
    cloud.heartbeat_run.assert_called_once_with(cloud.begin_run.return_value, worker.run_records)
    cloud.finish_run.assert_called_once_with(cloud.begin_run.return_value, worker.run_records)
    cloud.close.assert_called_once_with()


def test_worker_failure_is_sanitized_before_cloud_close():
    cloud = Mock()
    worker = Mock(run=AsyncMock(side_effect=RuntimeError("private provider detail")))

    with pytest.raises(RuntimeError, match="private provider detail"):
        asyncio.run(load_script().run_worker(cloud, worker, asyncio.Event()))

    cloud.fail_run.assert_called_once_with(cloud.begin_run.return_value, "worker-failed")
    cloud.close.assert_called_once_with()


def test_once_heartbeats_only_after_a_healthy_reconciliation():
    for healthy, expected in ((True, 0), (False, 1)):
        cloud = Mock()
        worker = Mock(reconcile_once=AsyncMock(return_value=healthy))
        worker.run_records = {"seen": 1, "written": int(healthy), "failed": int(not healthy)}

        assert (
            asyncio.run(load_script().run_worker(cloud, worker, asyncio.Event(), once=True))
            == expected
        )
        if healthy:
            cloud.heartbeat_run.assert_called_once_with(
                cloud.begin_run.return_value, worker.run_records
            )
            cloud.finish_run.assert_called_once_with(
                cloud.begin_run.return_value, worker.run_records
            )
        else:
            cloud.heartbeat_run.assert_not_called()
            cloud.fail_run.assert_called_once_with(cloud.begin_run.return_value, "worker-failed")


def test_realtime_supervisor_reconnects_and_cleans_up():
    module = load_script()
    worker = Mock()
    stopped = asyncio.Event()
    subscription = Mock(wait_closed=AsyncMock(), close=AsyncMock())
    attempts = [RuntimeError("offline"), subscription]
    delays: list[float] = []

    async def connect(_worker):
        outcome = attempts.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def sleep(seconds: float):
        delays.append(seconds)

    async def stop(*_args, **_kwargs):
        stopped.set()

    subscription.wait_closed.side_effect = stop
    asyncio.run(module.maintain_request_subscription(worker, stopped, connect=connect, sleep=sleep))

    assert delays == [1]
    subscription.close.assert_awaited_once_with()


def test_script_subscribes_to_owner_requests_and_wakes_worker():
    text = SCRIPT_PATH.read_text(encoding="utf-8")
    assert '"collector_requests"' in text
    assert 'f"owner_id=eq.{worker.owner_id}"' in text
    assert "worker.wake_requests()" in text
    assert "REQUEST_JOIN_TIMEOUT_SECONDS" in text
