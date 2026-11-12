"""Operate the Pi FX archive without fetching upstream rate providers."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from uuid import UUID

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))
from app.config import collector_config, local_data_dir
from app.services.collector_cloud import CollectorCloud
from app.services.fx.archive import compare_history, import_history, replay_history
from app.services.fx.collector import drain_outbox
from app.services.fx.store import Store
from app.services.process_lock import exclusive_process_lock


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("import", "replay"):
        command = commands.add_parser(name)
        command.add_argument("--checkpoint", type=Path, required=True)
        command.add_argument("--batch-size", type=int, default=500)
    commands.add_parser("drain")
    compare = commands.add_parser("compare")
    compare.add_argument("--batch-size", type=int, default=500)
    backup = commands.add_parser("backup")
    backup.add_argument("--output", type=Path, required=True)
    args = parser.parse_args(argv)

    cloud = None
    try:
        archive_path = local_data_dir() / "fx" / "outbox.sqlite"
        if args.command == "backup":
            owner_id = UUID(os.environ["EDICIUS_OWNER_ID"])
            with Store(archive_path, owner_id, readonly=True) as store:
                store.backup(args.output)
            print(json.dumps({"backup": "created"}))
            return 0

        cloud = CollectorCloud(collector_config())
        with Store(archive_path, cloud.owner_id, readonly=args.command == "compare") as store:
            if args.command == "import":
                scanned = import_history(
                    store,
                    cloud,
                    checkpoint=args.checkpoint,
                    batch_size=args.batch_size,
                    lock=lambda: exclusive_process_lock("fx"),
                )
                print(json.dumps({"scanned": scanned}))
            elif args.command == "replay":
                with exclusive_process_lock("fx"):
                    acknowledged = replay_history(
                        store, cloud, checkpoint=args.checkpoint, batch_size=args.batch_size
                    )
                print(json.dumps({"acknowledged": acknowledged}))
            elif args.command == "drain":
                with exclusive_process_lock("fx"):
                    acknowledged = drain_outbox(store, cloud)
                    pending = len(store.pending(limit=1))
                print(json.dumps({"acknowledged": acknowledged, "pending": pending}))
            else:
                report = compare_history(store, cloud, batch_size=args.batch_size)
                print(json.dumps(report, sort_keys=True))
                return int(not all(entry["matches"] for entry in report.values()))
        return 0
    except Exception:  # noqa: BLE001 - never print credentials, URLs or archived payloads
        print("FX archive operation failed", file=sys.stderr)
        return 1
    finally:
        if cloud is not None:
            cloud.close()


if __name__ == "__main__":
    raise SystemExit(main())
