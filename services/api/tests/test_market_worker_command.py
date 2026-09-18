from __future__ import annotations

import asyncio
import importlib.util
import sys
import uuid
from pathlib import Path
from types import ModuleType
from unittest.mock import AsyncMock, Mock

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "market-worker.py"


def load_script() -> ModuleType:
    name = f"market_worker_script_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_run_worker_closes_cloud_after_the_stop_signal():
    """A stopped service must release both the HTTP cloud and provider sessions."""
    cloud = Mock()
    cloud.owner_id = uuid.UUID("11111111-1111-1111-1111-111111111111")
    worker = Mock(run=AsyncMock())
    stopped = asyncio.Event()
    stopped.set()

    assert asyncio.run(load_script().run_worker(cloud, worker, stopped)) == 0

    worker.run.assert_awaited_once_with(stopped)
    cloud.close.assert_called_once_with()


def test_realtime_subscription_retries_after_initial_failure_and_disconnect():
    """A transient Realtime outage must return to push wakeups instead of polling forever."""
    module = load_script()
    worker = Mock()
    stopped = asyncio.Event()
    first = Mock(wait_closed=AsyncMock(), close=AsyncMock())
    second = Mock(wait_closed=AsyncMock(), close=AsyncMock())
    first.wait_closed.side_effect = RuntimeError("dropped")
    attempts = [RuntimeError("offline"), first, second]
    delays: list[float] = []

    async def connect(_worker):
        outcome = attempts.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    async def sleep(seconds: float):
        delays.append(seconds)

    async def stop_after_reconnect():
        stopped.set()

    second.wait_closed.side_effect = stop_after_reconnect

    asyncio.run(module.maintain_request_subscription(worker, stopped, connect=connect, sleep=sleep))

    assert delays == [1, 1]
    first.close.assert_awaited_once_with()
    second.close.assert_awaited_once_with()
