"""Offline timing spike: exercise the real market request handler with fake I/O.

This does not call Supabase or a market provider. The per-frame delays are the
24-hour mean claimed-to-completed times measured on 2026-10-24.
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from collections import deque
from datetime import UTC, datetime, timedelta
from pathlib import Path
from threading import Lock
from unittest.mock import Mock, patch
from uuid import UUID, uuid4

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "services" / "api"))

from app.adapters import registry
from app.adapters.models import Bar
from app.services.collector_cloud import CollectorRequest
from app.services.market_worker import MarketWorker

OWNER = UUID("11111111-1111-1111-1111-111111111111")
SERVICE_SECONDS = {
    "1m": 1.667,
    "5m": 1.137,
    "15m": 1.804,
    "1h": 1.629,
    "1d": 1.321,
    "1w": 1.004,
    "1M": 0.910,
}
FRAMES = ("1m", "5m", "15m", "1h", "1w", "1M")


class FakeCloud:
    def __init__(self, *, priority_visible: bool = False) -> None:
        self.owner_id = OWNER
        self._requests: deque[CollectorRequest] = deque()
        self._lock = Lock()
        self._priority_visible = priority_visible
        self.completed: list[str] = []
        self.claimed_at: dict[str, float] = {}

    def add(self, frame: str) -> None:
        now = datetime.now(UTC)
        with self._lock:
            self._requests.append(
                CollectorRequest(
                    id=uuid4(),
                    owner_id=OWNER,
                    operation="market-bars",
                    payload={"symbol": "AAPL", "timeframe": frame, "extended": False},
                    expires_at=now + timedelta(minutes=5),
                )
            )

    def claim_request(self, _operations: tuple[str, ...]) -> CollectorRequest | None:
        with self._lock:
            if not self._requests:
                return None
            request = next(
                (
                    item
                    for item in self._requests
                    if self._priority_visible and item.payload["timeframe"] == "1d"
                ),
                None,
            )
            if request is None:
                request = self._requests.popleft()
            else:
                self._requests.remove(request)
            self.claimed_at[request.payload["timeframe"]] = time.monotonic()
            return request

    def upsert_bars(self, _row: dict) -> None:
        pass

    def complete_request(self, _request_id: UUID, result: dict) -> None:
        self.completed.append(result["timeframe"])


async def claim_pool(worker: MarketWorker, width: int) -> None:
    """Candidate bounded scheduler; not a change to the production worker."""
    active: set[asyncio.Task[None]] = set()
    while True:
        while len(active) < width:
            request = await asyncio.to_thread(
                worker.cloud.claim_request, ("market-bars", "market-search")
            )
            if request is None:
                break
            active.add(asyncio.create_task(worker.serve_request(request)))
        if not active:
            return
        done, active = await asyncio.wait(active, return_when=asyncio.FIRST_COMPLETED)
        for task in done:
            task.result()


async def run(width: int) -> dict[str, object]:
    cloud = FakeCloud()
    for frame in FRAMES:
        cloud.add(frame)
    worker = MarketWorker(cloud, client=Mock())

    async def fake_fetch(
        _client: object, _symbol: str, frame: object, *, extended: bool
    ):
        assert extended is False
        await asyncio.sleep(SERVICE_SECONDS[frame.key])
        return [Bar(time=1, open=1, high=1, low=1, close=1, volume=1)]

    start = time.monotonic()
    with patch.object(registry, "fetch_bars", fake_fetch):
        if width == 1:
            count = await worker.claim_until_empty()
            assert count == len(FRAMES)
        else:
            await claim_pool(worker, width)
    elapsed = time.monotonic() - start
    assert len(cloud.completed) == len(FRAMES)
    return {
        "width": width,
        "elapsed_s": round(elapsed, 3),
        "completed": cloud.completed,
    }


async def duplicate_probe(width: int) -> dict[str, object]:
    cloud = FakeCloud()
    cloud.add("1m")
    cloud.add("1m")
    worker = MarketWorker(cloud, client=Mock())
    fetches = 0

    async def fake_fetch(
        _client: object, _symbol: str, _frame: object, *, extended: bool
    ):
        nonlocal fetches
        fetches += 1
        await asyncio.sleep(0.1)
        return [Bar(time=1, open=1, high=1, low=1, close=1, volume=1)]

    with patch.object(registry, "fetch_bars", fake_fetch):
        if width == 1:
            await worker.claim_until_empty()
        else:
            await claim_pool(worker, width)
    return {"width": width, "same_key_provider_fetches": fetches}


async def visible_probe(width: int, *, priority: bool = False) -> dict[str, object]:
    cloud = FakeCloud(priority_visible=priority)
    for frame in FRAMES:
        cloud.add(frame)
    worker = MarketWorker(cloud, client=Mock())

    async def fake_fetch(
        _client: object, _symbol: str, frame: object, *, extended: bool
    ):
        await asyncio.sleep(SERVICE_SECONDS[frame.key])
        return [Bar(time=1, open=1, high=1, low=1, close=1, volume=1)]

    with patch.object(registry, "fetch_bars", fake_fetch):
        task = asyncio.create_task(
            worker.claim_until_empty() if width == 1 else claim_pool(worker, width)
        )
        await asyncio.sleep(0.2)
        added = time.monotonic()
        cloud.add("1d")
        await task
    return {
        "width": width,
        "priority": priority,
        "visible_claim_wait_s": round(cloud.claimed_at["1d"] - added, 3),
    }


async def main() -> None:
    print(
        json.dumps(
            {
                "six_frame_burst": [await run(width) for width in (1, 2, 3)],
                "duplicate": [await duplicate_probe(width) for width in (1, 2)],
                "visible_after_prefetch": [
                    await visible_probe(width) for width in (1, 2, 3)
                ]
                + [await visible_probe(width, priority=True) for width in (2, 3)],
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
