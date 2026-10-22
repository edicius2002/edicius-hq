"""Run a scheduled SEACE pass or one queued owner-requested refresh on bodas."""

import argparse
import asyncio
import fcntl
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "services" / "api"))
sys.path.insert(0, str(ROOT / "services" / "seace"))

from app.config import collector_config
from app.services.collector_cloud import CollectorCloud
from incremental import refresh_region, region_name
from publish import publish_updates

PERU_TIME = timezone(timedelta(hours=-5))


def run_pass(cloud, region, year):
    region = region_name(region)
    if isinstance(year, bool) or not isinstance(year, int):
        raise TypeError("invalid SEACE year")
    run_id = cloud.begin_run("seace")
    written = 0
    try:
        def publisher(kind, updates, fetched_at, total):
            nonlocal written
            written += publish_updates(cloud, region, year, kind, updates, fetched_at, total)

        counts = asyncio.run(refresh_region(region, year, publisher=publisher))
        cloud.finish_run(run_id, {"seen": sum(v["total"] for v in counts.values()),
                                  "written": written, "failed": 0})
        return counts
    except Exception:
        cloud.fail_run(run_id, "seace_refresh_failed")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("scheduled", "requests"), required=True)
    parser.add_argument("--region", default="Arequipa")
    parser.add_argument("--year", type=int, default=datetime.now(PERU_TIME).year)
    args = parser.parse_args()
    state_dir = Path(os.environ.get("SEACE_STATE_DIR", "/var/lib/edicius-hq/seace"))
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / "seace.lock"
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # the next timer tick will retry a queued request
        cloud = CollectorCloud(collector_config())
        try:
            if args.mode == "scheduled":
                run_pass(cloud, args.region, args.year)
            else:
                request = cloud.claim_seace_refresh_request()
                if request is None:
                    return 0
                try:
                    region = request.payload.get("region")
                    year = request.payload.get("year")
                    if not isinstance(region, str):
                        raise TypeError("invalid SEACE request region")
                    counts = run_pass(cloud, region, year)
                    cloud.complete_request(request.id, {"region": region, "year": year,
                                                        "counts": counts})
                except Exception:
                    cloud.fail_request(request.id, "seace_refresh_failed")
                    raise
        finally:
            cloud.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
