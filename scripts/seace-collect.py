"""Run a scheduled SEACE pass or one queued owner-requested refresh on bodas."""

import argparse
import asyncio
import fcntl
import os
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "services" / "api"))
sys.path.insert(0, str(ROOT / "services" / "seace"))

from incremental import refresh_region, region_name  # noqa: E402
from publish import publish_updates  # noqa: E402

from app.config import collector_config  # noqa: E402
from app.services.collector_cloud import CollectorCloud  # noqa: E402

PERU_TIME = timezone(timedelta(hours=-5))
SCOPES = {
    "all": ("notices", "processes", "contracts"),
    "notices": ("notices",),
    "core": ("processes", "contracts"),
}


def run_pass(cloud, region, year, scope="all"):
    region = region_name(region)
    if isinstance(year, bool) or not isinstance(year, int):
        raise TypeError("invalid SEACE year")
    run_id = cloud.begin_run("seace")
    written = 0
    try:

        def publisher(kind, updates, fetched_at, total, added):
            nonlocal written
            written += publish_updates(cloud, region, year, kind, updates, fetched_at, total, added)

        counts = asyncio.run(refresh_region(region, year, publisher=publisher, kinds=SCOPES[scope]))
        cloud.finish_run(
            run_id,
            {
                "seen": sum(v["total"] for v in counts.values()),
                "written": written,
                "failed": 0,
            },
        )
        return counts
    except Exception:
        cloud.fail_run(run_id, "seace_refresh_failed")
        raise


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--mode", choices=("scheduled", "requests"), required=True)
    parser.add_argument("--scope", choices=tuple(SCOPES), default="all")
    parser.add_argument("--region", default="Arequipa")
    parser.add_argument("--year", type=int, default=datetime.now(PERU_TIME).year)
    args = parser.parse_args()
    if args.mode == "requests" and args.scope != "all":
        parser.error("queued owner refreshes always update all SEACE sources")
    state_dir = Path(os.environ.get("SEACE_STATE_DIR", "/var/lib/edicius-hq/seace"))
    state_dir.mkdir(parents=True, exist_ok=True)
    lock_path = state_dir / "seace.lock"
    with lock_path.open("a+") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return 0  # the next timer tick will retry a queued request
        cooldown_path = state_dir / "prod6-cooldown-until"
        if args.mode == "scheduled" and args.scope == "notices" and cooldown_path.exists():
            remaining = float(cooldown_path.read_text(encoding="ascii")) - time.time()
            if remaining > 0:
                print(f"SEACE prod6 cooldown active; retry after {remaining:.0f}s", flush=True)
                return 0
        cloud = CollectorCloud(collector_config())
        try:
            if args.mode == "scheduled":
                run_pass(cloud, args.region, args.year, scope=args.scope)
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
                    cloud.complete_request(
                        request.id, {"region": region, "year": year, "counts": counts}
                    )
                except Exception:
                    cloud.fail_request(request.id, "seace_refresh_failed")
                    raise
        finally:
            cloud.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
