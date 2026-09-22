"""Run the Pi market worker and wake its atomic claim loop from Realtime."""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import logging
import signal
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.config import collector_config  # noqa: E402
from app.services.collector_cloud import configured_collector_cloud  # noqa: E402
from app.services.market_worker import MarketWorker  # noqa: E402
from app.services.process_lock import (  # noqa: E402
    ProcessLockUnavailable,
    exclusive_process_lock,
)

LOGGER = logging.getLogger(__name__)
REQUEST_JOIN_TIMEOUT_SECONDS = 15.0


@dataclass
class RequestSubscription:
    """The small real-SDK surface a reconnect supervisor needs."""

    client: Any
    request_channel: Any
    focus_channel: Any

    @property
    def channels(self) -> tuple[Any, Any]:
        return self.request_channel, self.focus_channel

    async def wait_closed(
        self, stopped: asyncio.Event, *, sleep=asyncio.sleep, poll_seconds: float = 1.0
    ) -> None:
        while not stopped.is_set():
            realtime = self.client.realtime
            if not realtime.is_connected or any(
                channel.is_closed or channel.is_errored or not channel.is_joined
                for channel in self.channels
            ):
                return
            await sleep(poll_seconds)

    async def close(self) -> None:
        # The AsyncClient owns every channel's socket lifetime; this is the
        # verified 2.31.0 cleanup API (there is no AsyncClient.aclose()).
        await self.client.remove_all_channels()


async def subscribe_requests(worker: MarketWorker) -> RequestSubscription | None:
    """Subscribe this owner's request inserts and chart focus broadcasts."""
    client = None
    try:
        from realtime import RealtimePostgresChangesListenEvent, RealtimeSubscribeStates

        from supabase import create_async_client

        config = collector_config()
        client = await create_async_client(config.url, config.secret_key)
        request_channel = client.channel("market-worker-requests")
        request_channel.on_postgres_changes(
            RealtimePostgresChangesListenEvent.Insert,
            lambda _payload: worker.wake_requests(),
            "collector_requests",
            "public",
            f"owner_id=eq.{worker.owner_id}",
        )

        def on_focus(envelope: object) -> None:
            payload = envelope.get("payload") if isinstance(envelope, dict) else None
            worker.accept_focus(payload)

        focus_channel = client.channel(
            f"market-focus:{worker.owner_id}", {"config": {"private": True}}
        )
        focus_channel.on_broadcast("focus", on_focus)

        # The SDK returns from subscribe while the channel is still JOINING.
        # Wait for its acknowledgement before exposing it to the health monitor.
        request_joined: asyncio.Future[bool] = (
            asyncio.get_running_loop().create_future()
        )
        focus_joined: asyncio.Future[bool] = asyncio.get_running_loop().create_future()

        def on_join(
            joined: asyncio.Future[bool],
        ) -> Any:
            def callback(
                state: RealtimeSubscribeStates, _error: Exception | None
            ) -> None:
                if not joined.done():
                    joined.set_result(state == RealtimeSubscribeStates.SUBSCRIBED)

            return callback

        await request_channel.subscribe(on_join(request_joined))
        await focus_channel.subscribe(on_join(focus_joined))
        joined = await asyncio.wait_for(
            asyncio.gather(request_joined, focus_joined),
            timeout=REQUEST_JOIN_TIMEOUT_SECONDS,
        )
        if not all(joined):
            raise RuntimeError("realtime join failed")
        return RequestSubscription(client, request_channel, focus_channel)
    except (Exception, asyncio.CancelledError) as exc:
        if client is not None:
            with contextlib.suppress(Exception):
                await client.remove_all_channels()
        if isinstance(exc, asyncio.CancelledError):
            raise
        return None


async def maintain_request_subscription(
    worker: MarketWorker,
    stopped: asyncio.Event,
    *,
    connect=subscribe_requests,
    sleep=asyncio.sleep,
    poll_seconds: float = 1.0,
) -> None:
    """Reconnect push wakeups with bounded backoff; polling remains reconciliation."""
    backoff = 1.0
    while not stopped.is_set():
        subscription = None
        try:
            subscription = await connect(worker)
            if subscription is None:
                raise RuntimeError("realtime unavailable")
            backoff = 1.0
            await subscription.wait_closed(stopped, sleep=sleep, poll_seconds=poll_seconds)
        except asyncio.CancelledError:
            raise
        except Exception:  # noqa: BLE001 - Realtime errors are healed by reconnect and claim RPC
            pass
        finally:
            if subscription is not None:
                with contextlib.suppress(Exception):
                    await subscription.close()
        if not stopped.is_set():
            await sleep(backoff)
            backoff = min(backoff * 2, 60.0)


async def run_worker(
    cloud: Any, worker: MarketWorker, stopped: asyncio.Event, *, once: bool = False
) -> int:
    realtime: asyncio.Task[None] | None = None
    run_id = None
    try:
        run_id = cloud.begin_run("market")
        if once:
            healthy = await worker.reconcile_once()
            if not healthy:
                cloud.fail_run(run_id, "provider-failed")
                return 1
            cloud.heartbeat_run(run_id, worker.run_records)
        else:
            realtime = asyncio.create_task(maintain_request_subscription(worker, stopped))
            await worker.run(
                stopped,
                lambda records: cloud.heartbeat_run(run_id, records),
            )
        cloud.finish_run(run_id, worker.run_records)
        return 0
    except BaseException:
        if run_id is not None:
            try:
                cloud.fail_run(run_id, "worker-failed")
            except Exception:  # noqa: BLE001 - preserve the worker failure
                LOGGER.error("market worker could not mark its run failed")
        raise
    finally:
        if realtime is not None:
            realtime.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await realtime
        cloud.close()


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--once", action="store_true", help="run one bounded reconciliation")
    return parser.parse_args()


async def main_async() -> int:
    args = parse_args()
    cloud = configured_collector_cloud()
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stopped.set)
        except NotImplementedError:
            signal.signal(signum, lambda *_args: loop.call_soon_threadsafe(stopped.set))
    return await run_worker(cloud, MarketWorker(cloud), stopped, once=args.once)


def main() -> int:
    try:
        with exclusive_process_lock("market"):
            return asyncio.run(main_async())
    except ProcessLockUnavailable:
        LOGGER.error("market collector is already running")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
