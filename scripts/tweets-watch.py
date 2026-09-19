"""Run the single X browser-profile owner and replay its local JSONL outbox."""

from __future__ import annotations

import argparse
import asyncio
import logging
import signal
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.config import tweets_dir  # noqa: E402
from app.services.collector_cloud import CollectorCloud, configured_collector_cloud  # noqa: E402
from app.services.process_lock import (  # noqa: E402
    ProcessLockUnavailable,
    exclusive_process_lock,
)
from app.services.tweet_replica import TweetReplica  # noqa: E402
from app.services.tweet_watcher import TweetWatcher  # noqa: E402

LOGGER = logging.getLogger(__name__)


async def run_worker(
    handle: str,
    cloud: CollectorCloud,
    watcher: TweetWatcher,
    replica: TweetReplica,
    stopped: asyncio.Event,
    *,
    once: bool = False,
) -> int:
    """Replay before Chromium starts, then keep its profile in one process."""
    replayed = 0
    try:
        replayed = await asyncio.to_thread(replica.replay, handle)
    except Exception:  # noqa: BLE001 - the retained outbox is retried by later captures
        LOGGER.error("X worker could not replay its local outbox")
    try:
        run_id = cloud.begin_run("x-posts")
    except Exception:  # noqa: BLE001 - health loss must not stop local capture
        LOGGER.error("X worker could not initialize its cloud run")
        run_id = None
    try:
        records = {"seen": replayed, "written": replayed, "failed": 0}

        def heartbeat(refresh) -> None:
            records["seen"] += refresh.new
            records["written"] += refresh.new
            if run_id is not None:
                cloud.heartbeat_run(run_id, records)

        watcher.set_run_observer(heartbeat)
        if once:
            await watcher.run_once(handle)
        else:
            watcher.watch(handle)
            stop_wait = asyncio.create_task(stopped.wait())
            watch_task = getattr(watcher, "_loop_task", None)
            if isinstance(watch_task, asyncio.Future):
                await asyncio.wait({stop_wait, watch_task}, return_when=asyncio.FIRST_COMPLETED)
            else:
                await stop_wait
            stop_wait.cancel()
        failed = watcher.current(handle)
        if failed is not None and failed.state == "failed":
            if run_id is not None:
                cloud.fail_run(run_id, "session-failed")
            return 1
        if run_id is not None:
            cloud.finish_run(run_id, records)
        return 0
    except Exception:  # noqa: BLE001 - fatal worker errors must produce a nonzero service exit
        try:
            if run_id is not None:
                cloud.fail_run(run_id, "session-failed")
        except Exception:  # noqa: BLE001 - preserve the original fatal outcome
            LOGGER.error("X worker could not mark its run failed")
        return 1
    finally:
        await watcher.stop()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Watch one X handle with its local outbox")
    parser.add_argument("--handle", required=True, help="X handle without needing a browser login")
    parser.add_argument("--once", action="store_true", help="capture and replay exactly one pass")
    return parser.parse_args()


async def main_async() -> int:
    args = parse_args()
    handle = args.handle.lstrip("@")
    cloud = configured_collector_cloud()
    archive = tweets_dir() / f"{handle}.jsonl"
    replica = TweetReplica(archive, cloud)
    watcher = TweetWatcher(data_dir=tweets_dir(), replica=replica)
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stopped.set)
        except NotImplementedError:
            signal.signal(signum, lambda *_args: loop.call_soon_threadsafe(stopped.set))
    return await run_worker(handle, cloud, watcher, replica, stopped, once=args.once)


def main() -> int:
    try:
        with exclusive_process_lock("tweets"):
            return asyncio.run(main_async())
    except ProcessLockUnavailable:
        LOGGER.error("X collector is already running")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
