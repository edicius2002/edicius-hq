import asyncio
import importlib.util
import sys
import uuid
from pathlib import Path
from types import ModuleType
from unittest.mock import AsyncMock, Mock

from app.services.collector_cloud import CollectorCloudUnavailable

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "tweets-watch.py"


def load_script() -> ModuleType:
    name = f"tweets_watch_script_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_worker_replays_before_opening_the_browser_and_closes_on_stop():
    events: list[str] = []
    stopped = asyncio.Event()
    replica = Mock()
    watcher = Mock()
    watcher.stop = AsyncMock()
    watcher.watch.side_effect = lambda _handle: (events.append("watch"), stopped.set())
    cloud = Mock()
    cloud.begin_run.return_value = uuid.UUID("22222222-2222-2222-2222-222222222222")

    assert (
        asyncio.run(load_script().run_worker("thsottiaux", cloud, watcher, replica, stopped)) == 0
    )

    replica.replay.assert_called_once_with("thsottiaux")
    assert events == ["watch"]
    watcher.stop.assert_awaited_once_with()
    cloud.finish_run.assert_called_once_with(
        cloud.begin_run.return_value, {"seen": 0, "written": 0, "failed": 0}
    )


def test_worker_marks_a_fatal_watcher_failure_and_exits_nonzero():
    stopped = asyncio.Event()
    replica = Mock()
    watcher = Mock()
    watcher.stop = AsyncMock()
    watcher.watch.side_effect = lambda _handle: stopped.set()
    watcher.current.return_value = type("Refresh", (), {"state": "failed"})()
    cloud = Mock()
    cloud.begin_run.return_value = uuid.UUID("22222222-2222-2222-2222-222222222222")

    assert (
        asyncio.run(load_script().run_worker("thsottiaux", cloud, watcher, replica, stopped)) == 1
    )

    watcher.stop.assert_awaited_once_with()
    cloud.fail_run.assert_called_once_with(cloud.begin_run.return_value, "session-failed")


def test_worker_keeps_watching_when_the_initial_outbox_replay_is_offline():
    stopped = asyncio.Event()
    replica = Mock()
    replica.replay.side_effect = CollectorCloudUnavailable("offline")
    watcher = Mock()
    watcher.stop = AsyncMock()
    watcher.watch.side_effect = lambda _handle: stopped.set()
    watcher.current.return_value = None
    cloud = Mock()
    cloud.begin_run.return_value = uuid.UUID("22222222-2222-2222-2222-222222222222")

    assert (
        asyncio.run(load_script().run_worker("thsottiaux", cloud, watcher, replica, stopped)) == 0
    )

    watcher.watch.assert_called_once_with("thsottiaux")
