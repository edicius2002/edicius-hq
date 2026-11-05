"""Measure local Pi publication and focused Yahoo fetch spacing without network I/O.

Run this same script with PYTHONPATH pointing at each source tree's services/api
to compare scheduling behavior. The fake cloud can emulate a broadcast POST delay.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import time
from datetime import datetime
from itertools import pairwise
from uuid import UUID
from zoneinfo import ZoneInfo

import httpx
from app.adapters.live_bars import CompositeBarStream
from app.adapters.models import Bar, BarFocus, LiveBar, Tick
from app.services.market_worker import MarketWorker

OPEN_MARKET = datetime(
    2026, 9, 22, 10, 0, tzinfo=ZoneInfo("America/New_York")
).timestamp()
OWNER = UUID("11111111-1111-1111-1111-111111111111")


class RecordingCloud:
    owner_id = OWNER

    def __init__(self, post_seconds: float) -> None:
        self.post_seconds = post_seconds
        self.sent_at: list[float] = []

    def broadcast_quote_ticks(self, rows: list[dict]) -> int:
        self.sent_at.append(time.monotonic())
        time.sleep(self.post_seconds)
        return len(rows)


class IdleBinance:
    async def watch(self, _focuses: set[BarFocus]) -> None:
        pass


class RecordingYahoo:
    def __init__(self) -> None:
        self.fetched_at: list[float] = []

    async def fetch(self, focus: BarFocus) -> LiveBar:
        now = time.monotonic()
        self.fetched_at.append(now)
        return LiveBar(
            symbol=focus.symbol,
            timeframe=focus.timeframe,
            extended=focus.extended,
            as_of=now,
            bar=Bar(time=100, open=100, high=100, low=100, close=100, volume=1),
            provider="yahoo",
        )


def summary(times: list[float]) -> dict[str, float | int]:
    intervals = [round((b - a) * 1000, 1) for a, b in pairwise(times)]
    if not intervals:
        raise RuntimeError("Too few events to measure a cadence")
    ordered = sorted(intervals)
    p95_at = (len(ordered) - 1) * 0.95
    lower = int(p95_at)
    upper = min(lower + 1, len(ordered) - 1)
    return {
        "events": len(times),
        "intervals": len(intervals),
        "median_ms": round(statistics.median(intervals), 1),
        "p95_ms": round(
            ordered[lower] + (ordered[upper] - ordered[lower]) * (p95_at - lower), 1
        ),
        "min_ms": ordered[0],
        "max_ms": ordered[-1],
    }


async def measure(duration: float, post_seconds: float) -> dict:
    cloud = RecordingCloud(post_seconds)
    yahoo = RecordingYahoo()
    bars = CompositeBarStream(IdleBinance(), yahoo, clock=lambda: OPEN_MARKET)
    stopped = asyncio.Event()

    async with httpx.AsyncClient() as client:
        worker = MarketWorker(cloud, client=client)
        worker.accept_quote_interest(
            {"clientId": "probe", "active": True, "symbols": ["AAPL"]}
        )
        publisher = asyncio.create_task(worker._publish_ticks(stopped))
        await bars.watch({BarFocus("AAPL", "1m", False)})
        started = time.monotonic()
        next_tick = started
        tick_number = 0
        try:
            while time.monotonic() - started < duration:
                if time.monotonic() >= next_tick:
                    tick_number += 1
                    worker.accept(
                        Tick("AAPL", 100 + tick_number / 100, "yahoo", time=tick_number)
                    )
                    next_tick += 0.05
                await asyncio.sleep(0.005)
        finally:
            stopped.set()
            await publisher
            await bars.close()

    return {
        "duration_s": duration,
        "simulated_post_ms": round(post_seconds * 1000),
        "quote_broadcast": summary(cloud.sent_at),
        "yahoo_candle_fetch": summary(yahoo.fetched_at),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--duration", type=float, default=12.5)
    parser.add_argument("--post-ms", type=float, default=0)
    args = parser.parse_args()
    if args.duration <= 0 or args.post_ms < 0:
        parser.error("duration must be positive and post-ms nonnegative")
    print(
        json.dumps(
            asyncio.run(measure(args.duration, args.post_ms / 1000)), sort_keys=True
        )
    )


if __name__ == "__main__":
    main()
