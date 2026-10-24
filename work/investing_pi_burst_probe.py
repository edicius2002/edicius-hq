"""One bounded six-frame market-bars burst through the production queue."""

from __future__ import annotations

import json
import sys
import time
from datetime import datetime

sys.path.insert(0, "services/api")

from app.services.collector_cloud import configured_collector_cloud

FRAMES = ("1m", "5m", "15m", "1h", "1d", "1M")
TERMINAL = {"complete", "failed", "expired"}


def stamp(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def main() -> None:
    cloud = configured_collector_cloud()
    try:
        started = time.monotonic()
        requests = cloud._request(
            "POST",
            "collector_requests",
            params={"select": "request_id"},
            headers={"Prefer": "return=representation"},
            body=[
                {
                    "owner_id": str(cloud.owner_id),
                    "operation": "market-bars",
                    "payload": {"symbol": "BNO", "timeframe": frame, "extended": True},
                }
                for frame in FRAMES
            ],
        )
        inserted = time.monotonic()
        if not isinstance(requests, list) or len(requests) != len(FRAMES):
            raise RuntimeError("unexpected insert response")
        ids = [str(row["request_id"]) for row in requests]
        deadline = started + 75
        rows: list[dict[str, object]] = []
        while time.monotonic() < deadline:
            result = cloud._request(
                "GET",
                "collector_requests",
                params={
                    "select": "request_id,status,payload,created_at,claimed_at,completed_at,error_code",
                    "owner_id": f"eq.{cloud.owner_id}",
                    "request_id": f"in.({','.join(ids)})",
                },
            )
            if not isinstance(result, list) or len(result) != len(FRAMES):
                raise RuntimeError("unexpected poll response")
            rows = result
            if all(row["status"] in TERMINAL for row in rows):
                break
            time.sleep(0.3)
        finished = time.monotonic()
        claim_order = sorted(rows, key=lambda row: stamp(row["claimed_at"]))
        claim_gaps = [
            round(
                (stamp(later["claimed_at"]) - stamp(earlier["completed_at"])).total_seconds(),
                3,
            )
            for earlier, later in zip(claim_order, claim_order[1:])
        ]
        summary = []
        for row in rows:
            created = stamp(row["created_at"])
            claimed = stamp(row["claimed_at"]) if row["claimed_at"] else None
            completed = stamp(row["completed_at"]) if row["completed_at"] else None
            summary.append(
                {
                    "frame": row["payload"]["timeframe"],
                    "status": row["status"],
                    "error": row["error_code"],
                    "queue_s": round((claimed - created).total_seconds(), 3) if claimed else None,
                    "service_s": (
                        round((completed - claimed).total_seconds(), 3)
                        if claimed and completed
                        else None
                    ),
                    "from_first_created_s": (
                        round((completed - min(stamp(item["created_at"]) for item in rows)).total_seconds(), 3)
                        if completed
                        else None
                    ),
                }
            )
        print(
            json.dumps(
                {
                    "insert_s": round(inserted - started, 3),
                    "wall_s": round(finished - started, 3),
                    "claim_order": [row["payload"]["timeframe"] for row in claim_order],
                    "claim_gaps_s": claim_gaps,
                    "requests": sorted(summary, key=lambda row: FRAMES.index(row["frame"])),
                }
            )
        )
    finally:
        cloud.close()


if __name__ == "__main__":
    main()
