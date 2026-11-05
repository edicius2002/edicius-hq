"""Read-only 20-second sample of Yahoo AAPL quote ticks from the Pi."""

from __future__ import annotations

import asyncio
import json
import statistics
import sys
import time
from itertools import pairwise

sys.path.insert(0, "services/api")

from app.adapters.yahoo_stream import YahooStream


async def main() -> None:
    stream = YahooStream()
    await stream.watch({"AAPL"})
    timestamps: list[float] = []
    ages: list[float] = []
    previous_price: float | None = None
    raw_frames = 0
    started = time.monotonic()
    ticks = stream.ticks()
    try:
        while True:
            remaining = 20 - (time.monotonic() - started)
            if remaining <= 0:
                break
            try:
                tick = await asyncio.wait_for(anext(ticks), timeout=remaining)
            except TimeoutError:
                break
            raw_frames += 1
            if tick.price != previous_price:
                timestamps.append(time.monotonic())
                previous_price = tick.price
                if tick.time is not None:
                    ages.append(time.time() - tick.time)
    finally:
        await ticks.aclose()
    gaps = [(b - a) * 1000 for a, b in pairwise(timestamps)]
    print(
        json.dumps(
            {
                "duration_s": round(time.monotonic() - started, 1),
                "frames": raw_frames,
                "changed_prices": len(timestamps),
                "median_changed_gap_ms": round(statistics.median(gaps))
                if gaps
                else None,
                "median_exchange_age_ms": round(statistics.median(ages) * 1000)
                if ages
                else None,
            }
        )
    )


if __name__ == "__main__":
    asyncio.run(main())
