"""Collect standard USD/PEN quotes into the durable local outbox."""

from __future__ import annotations

import argparse
import logging
import sys
from contextlib import nullcontext
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))
from app.config import collector_config, local_data_dir
from app.services.collector_cloud import CollectorCloud
from app.services.fx.collector import collect_once
from app.services.fx.models import SOURCES
from app.services.fx.store import Store
from app.services.process_lock import (
    ProcessLockUnavailable,
    exclusive_process_lock,
)

LOGGER = logging.getLogger(__name__)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--sources",
        help="Comma-separated source slugs; default all",
    )
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    sources = args.sources.split(",") if args.sources else SOURCES
    cloud = None
    try:
        if not args.dry_run:
            cloud = CollectorCloud(collector_config())
        lock = nullcontext() if args.dry_run else exclusive_process_lock("fx")
        with (
            lock,
            (
                Store(local_data_dir() / "fx" / "outbox.sqlite", cloud.owner_id)
                if cloud
                else nullcontext(None)
            ) as store,
        ):
            result = collect_once(store, cloud, sources, dry_run=args.dry_run)
        print(f"FX seen={result['seen']} written={result['written']} failed={result['failed']}")
        return int(result["failed"] > 0)
    except (ValueError, ProcessLockUnavailable) as error:
        LOGGER.error("FX collection unavailable: %s", error)
        return 1
    finally:
        if cloud:
            cloud.close()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    raise SystemExit(main())
