"""Read-only sample of the real Yahoo focused candle fetch from a Pi release."""

from __future__ import annotations

import asyncio
import json
import sys
import time

import httpx

sys.path.insert(0, "services/api")

from app.adapters.models import BarFocus
from app.adapters.yahoo_live_bars import YahooLiveBarClient
from app.config import UPSTREAM_TIMEOUT_SECONDS


async def main() -> None:
    results = []
    previous = None
    async with httpx.AsyncClient(
        timeout=UPSTREAM_TIMEOUT_SECONDS, follow_redirects=True
    ) as client:
        provider = YahooLiveBarClient(client)
        focus = BarFocus("AAPL", "1m", False)
        for index in range(8):
            started = time.monotonic()
            update = await provider.fetch(focus)
            elapsed = time.monotonic() - started
            results.append(
                {
                    "fetch_ms": round(elapsed * 1000),
                    "has_bar": update is not None,
                    "changed": (
                        update is not None
                        and previous is not None
                        and update.bar != previous.bar
                    ),
                    "provider_as_of_delta_s": (
                        round(update.as_of - previous.as_of, 1)
                        if update is not None and previous is not None
                        else None
                    ),
                }
            )
            previous = update
            if index < 7:
                await asyncio.sleep(2)
    print(json.dumps(results))


if __name__ == "__main__":
    asyncio.run(main())
