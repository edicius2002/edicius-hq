"""Small live Yahoo adapter timing probe, piped over SSH without remote writes."""

from __future__ import annotations

import asyncio
import json
import sys
import time

import httpx

sys.path.insert(0, "services/api")

from app.adapters import registry
from app.adapters.models import ProviderError
from app.config import TIMEFRAMES, UPSTREAM_TIMEOUT_SECONDS


async def main() -> None:
    frames = tuple(sys.argv[1:]) or ("1m", "5m")
    if (
        len(frames) > 6
        or len(set(frames)) != len(frames)
        or any(frame not in TIMEFRAMES for frame in frames)
    ):
        raise ValueError("provide up to six distinct supported timeframes")
    async with httpx.AsyncClient(
        timeout=UPSTREAM_TIMEOUT_SECONDS, follow_redirects=True
    ) as client:

        async def fetch(frame: str) -> dict[str, object]:
            start = time.monotonic()
            try:
                bars = await registry.fetch_bars(client, "AAPL", TIMEFRAMES[frame])
            except ProviderError as error:
                return {
                    "frame": frame,
                    "error": error.code,
                    "seconds": round(time.monotonic() - start, 3),
                }
            return {
                "frame": frame,
                "bars": len(bars),
                "seconds": round(time.monotonic() - start, 3),
            }

        async def bounded(frame: str, permits: asyncio.Semaphore) -> dict[str, object]:
            async with permits:
                return await fetch(frame)

        # Establish the connection before the timed rounds.
        warmup = await fetch("1d")
        rounds: list[dict[str, object]] = []
        for mode in ("serial", "parallel", "parallel", "serial"):
            start = time.monotonic()
            if mode == "serial":
                results = [await fetch(frame) for frame in frames]
            else:
                permits = asyncio.Semaphore(2)
                results = await asyncio.gather(
                    *(bounded(frame, permits) for frame in frames)
                )
            rounds.append(
                {
                    "mode": mode,
                    "wall_seconds": round(time.monotonic() - start, 3),
                    "results": results,
                }
            )
            if any("error" in result for result in results):
                break
            await asyncio.sleep(1.0)
        print(json.dumps({"frames": frames, "warmup": warmup, "rounds": rounds}))


if __name__ == "__main__":
    asyncio.run(main())
