"""Run the Pi market worker and wake its atomic claim loop from Realtime."""

from __future__ import annotations

import asyncio
import signal
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT / "services" / "api"))

from app.config import collector_config  # noqa: E402
from app.services.collector_cloud import configured_collector_cloud  # noqa: E402
from app.services.market_worker import MarketWorker  # noqa: E402


async def subscribe_requests(worker: MarketWorker) -> Any | None:
    """Subscribe only to this owner's inserts; claim RPC remains the authority."""
    try:
        from supabase import create_async_client

        config = collector_config()
        client = await create_async_client(config.url, config.secret_key)
        channel = client.channel("market-worker-requests")
        channel.on_postgres_changes(
            "INSERT",
            schema="public",
            table="collector_requests",
            filter=f"owner_id=eq.{worker.owner_id}",
            callback=lambda _payload: worker.wake_requests(),
        )
        await channel.subscribe()
        return client
    except Exception:  # noqa: BLE001 - 30-second reconciliation heals a dropped wakeup
        return None


async def run_worker(cloud: Any, worker: MarketWorker, stopped: asyncio.Event) -> int:
    realtime = await subscribe_requests(worker)
    try:
        await worker.run(stopped)
        return 0
    finally:
        if realtime is not None:
            await realtime.remove_all_channels()
        cloud.close()


async def main_async() -> int:
    cloud = configured_collector_cloud()
    stopped = asyncio.Event()
    loop = asyncio.get_running_loop()
    for signum in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(signum, stopped.set)
        except NotImplementedError:
            signal.signal(signum, lambda *_args: loop.call_soon_threadsafe(stopped.set))
    return await run_worker(cloud, MarketWorker(cloud), stopped)


def main() -> int:
    return asyncio.run(main_async())


if __name__ == "__main__":
    raise SystemExit(main())
