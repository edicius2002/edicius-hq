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

    async def stop_after_reconnect(*_args, **_kwargs):
        stopped.set()

    second.wait_closed.side_effect = stop_after_reconnect

    asyncio.run(module.maintain_request_subscription(worker, stopped, connect=connect, sleep=sleep))

    assert delays == [1, 1]
    first.close.assert_awaited_once_with()
    second.close.assert_awaited_once_with()


def test_realtime_monitor_recreates_client_when_joined_channel_becomes_errored():
    """Join callbacks are one-shot; a later SDK error must drive reconnection."""
    module = load_script()
    stopped = asyncio.Event()
    worker = Mock()
    first_channel = Mock(is_closed=False, is_errored=False, is_joined=True)
    second_channel = Mock(is_closed=False, is_errored=False, is_joined=True)
    first_client = Mock(realtime=Mock(is_connected=True), remove_all_channels=AsyncMock())
    second_client = Mock(realtime=Mock(is_connected=True), remove_all_channels=AsyncMock())
    first = module.RequestSubscription(first_client, first_channel)
    second = module.RequestSubscription(second_client, second_channel)
    attempts = [first, second]
    sleeps: list[float] = []

    async def connect(_worker):
        return attempts.pop(0)

    async def sleep(seconds: float):
        sleeps.append(seconds)
        if len(sleeps) == 1:
            first_channel.is_errored = True
        elif len(sleeps) == 3:
            stopped.set()

    asyncio.run(
        module.maintain_request_subscription(
            worker, stopped, connect=connect, sleep=sleep, poll_seconds=1
        )
    )

    assert sleeps == [1, 1, 1]
    first_client.remove_all_channels.assert_awaited_once_with()
    second_client.remove_all_channels.assert_awaited_once_with()


def test_subscription_close_awaits_the_sdk_channel_cleanup():
    """Dropping this await leaks a coroutine and fails shutdown after reconnect exhaustion."""
    module = load_script()
    client = Mock(remove_all_channels=AsyncMock())

    asyncio.run(module.RequestSubscription(client, Mock()).close())

    client.remove_all_channels.assert_awaited_once_with()
