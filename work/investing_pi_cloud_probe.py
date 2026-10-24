"""Read-only Pi to Supabase timing probe; never prints credentials or payloads."""

from __future__ import annotations

import json
import sys
import time

sys.path.insert(0, "services/api")

from app.services.collector_cloud import configured_collector_cloud


def main() -> None:
    cloud = configured_collector_cloud()
    try:
        timings: list[dict[str, float | int]] = []
        for _ in range(5):
            start = time.monotonic()
            rows = cloud.list_cached_bars()
            timings.append(
                {
                    "metadata_rows": len(rows),
                    "seconds": round(time.monotonic() - start, 3),
                }
            )
        print(json.dumps(timings))
    finally:
        cloud.close()


if __name__ == "__main__":
    main()
