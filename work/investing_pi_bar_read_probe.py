"""Read-only timing of the full market_bars rows from the Pi to Supabase."""

from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, "services/api")

from app.services.collector_cloud import configured_collector_cloud


def main() -> None:
    cloud = configured_collector_cloud()
    try:
        cases = (("USO", "15m"), ("USO", "1M"), ("BNO", "1w"))
        results: list[dict[str, object]] = []
        for symbol, timeframe in cases:
            samples = []
            for _ in range(3):
                started = time.monotonic()
                rows = cloud._request(
                    "GET",
                    "market_bars",
                    params={
                        "select": "provider,payload,fetched_at,expires_at",
                        "owner_id": f"eq.{cloud.owner_id}",
                        "symbol": f"eq.{symbol}",
                        "timeframe": f"eq.{timeframe}",
                        "extended": "eq.true",
                        "limit": "1",
                    },
                )
                samples.append(round(time.monotonic() - started, 3))
            results.append(
                {
                    "symbol": symbol,
                    "timeframe": timeframe,
                    "rows": len(rows),
                    "payload_bytes": len(json.dumps(rows).encode("utf-8")),
                    "seconds": samples,
                }
            )
        for symbol in ("USO", "BNO"):
            samples = []
            for _ in range(3):
                started = time.monotonic()
                rows = cloud._request(
                    "GET",
                    "market_bars",
                    params={
                        "select": "timeframe,provider,payload,fetched_at,expires_at",
                        "owner_id": f"eq.{cloud.owner_id}",
                        "symbol": f"eq.{symbol}",
                        "extended": "eq.true",
                        "limit": "7",
                    },
                )
                samples.append(round(time.monotonic() - started, 3))
            results.append(
                {
                    "symbol": symbol,
                    "timeframe": "all-seven",
                    "rows": len(rows),
                    "payload_bytes": len(json.dumps(rows).encode("utf-8")),
                    "seconds": samples,
                }
            )
        print(json.dumps(results))
    finally:
        cloud.close()


if __name__ == "__main__":
    main()
