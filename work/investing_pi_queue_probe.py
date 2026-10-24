"""Read-only cache and queue summary from the production collector host."""

from __future__ import annotations

import json
import statistics
import sys
from datetime import UTC, datetime, timedelta

sys.path.insert(0, "services/api")

from app.services.collector_cloud import configured_collector_cloud


def timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def percentile(values: list[float], fraction: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    index = (len(ordered) - 1) * fraction
    lower = int(index)
    upper = min(lower + 1, len(ordered) - 1)
    return round(ordered[lower] + (ordered[upper] - ordered[lower]) * (index - lower), 3)


def main() -> None:
    cloud = configured_collector_cloud()
    try:
        now = datetime.now(UTC)
        cache = cloud.list_cached_bars()
        frame_names = ("1m", "5m", "15m", "1h", "1d", "1w", "1M")
        matrix = {}
        for symbol in ("USO", "BNO"):
            frames = []
            for frame in frame_names:
                row = next(
                    (
                        item
                        for item in cache
                        if item["symbol"] == symbol
                        and item["timeframe"] == frame
                        and item["extended"] is True
                    ),
                    None,
                )
                frames.append(
                    {
                        "frame": frame,
                        "state": (
                            "missing"
                            if row is None
                            else "fresh"
                            if timestamp(row["expires_at"]) > now
                            else "expired"
                        ),
                    }
                )
            matrix[symbol] = frames

        since = now - timedelta(days=1)
        rows = cloud._request(
            "GET",
            "collector_requests",
            params={
                "select": "created_at,claimed_at,completed_at",
                "owner_id": f"eq.{cloud.owner_id}",
                "operation": "eq.market-bars",
                "status": "eq.complete",
                "created_at": f"gte.{since.isoformat()}",
                "limit": "1000",
            },
        )
        queues = []
        services = []
        for row in rows:
            queues.append((timestamp(row["claimed_at"]) - timestamp(row["created_at"])).total_seconds())
            services.append(
                (timestamp(row["completed_at"]) - timestamp(row["claimed_at"])).total_seconds()
            )
        print(
            json.dumps(
                {
                    "cache": matrix,
                    "requests_24h": len(rows),
                    "queue_p50_s": percentile(queues, 0.5),
                    "queue_p95_s": percentile(queues, 0.95),
                    "service_p50_s": percentile(services, 0.5),
                    "service_p95_s": percentile(services, 0.95),
                    "queue_mean_s": round(statistics.mean(queues), 3) if queues else None,
                }
            )
        )
    finally:
        cloud.close()


if __name__ == "__main__":
    main()
