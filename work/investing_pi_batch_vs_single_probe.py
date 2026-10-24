"""Compare seven serial cache reads with one grouped read from the Pi."""

from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, "services/api")

from app.services.collector_cloud import configured_collector_cloud

FRAMES = ("1m", "5m", "15m", "1h", "1d", "1w", "1M")


def main() -> None:
    cloud = configured_collector_cloud()
    try:
        results: list[dict[str, object]] = []
        for symbol in ("USO", "BNO"):
            for mode in ("single", "batch", "batch", "single"):
                started = time.monotonic()
                if mode == "single":
                    rows = [
                        row
                        for frame in FRAMES
                        for row in cloud._request(
                            "GET",
                            "market_bars",
                            params={
                                "select": "provider,payload,fetched_at,expires_at",
                                "owner_id": f"eq.{cloud.owner_id}",
                                "symbol": f"eq.{symbol}",
                                "timeframe": f"eq.{frame}",
                                "extended": "eq.true",
                                "limit": "1",
                            },
                        )
                    ]
                else:
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
                results.append(
                    {
                        "symbol": symbol,
                        "mode": mode,
                        "rows": len(rows),
                        "bytes": len(json.dumps(rows).encode("utf-8")),
                        "seconds": round(time.monotonic() - started, 3),
                    }
                )
        print(json.dumps(results))
    finally:
        cloud.close()


if __name__ == "__main__":
    main()
