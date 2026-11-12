"""Plan or resume supervised Airfare retention by UTC departure date."""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "services" / "api"))

from app.config import airfare_supabase_config, local_data_dir
from app.services.airfare_retention_runner import RetentionRunner
from app.services.airfare_supabase import AirfareRemoteError, SupabaseAirfare


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", help="Read-only plan and replica preflight")
    mode.add_argument(
        "--apply", action="store_true", help="Start or resume the fenced retention run"
    )
    args = parser.parse_args(argv)
    try:
        config = airfare_supabase_config()
    except ValueError:
        print(
            json.dumps({"phase": "unavailable", "error": "Invalid Airfare replica configuration"})
        )
        return 1
    if config is None:
        print(json.dumps({"phase": "unavailable", "error": "Airfare replica is not configured"}))
        return 1
    try:
        remote = SupabaseAirfare(
            config.url, config.secret_key, timeout_seconds=config.timeout_seconds
        )
    except ValueError:
        print(
            json.dumps({"phase": "unavailable", "error": "Invalid Airfare replica configuration"})
        )
        return 1
    try:
        report = RetentionRunner(local_data_dir(), remote).run(
            now=datetime.now(UTC), dry_run=not args.apply
        )
    except (AirfareRemoteError, OSError, ValueError, TypeError) as error:
        print(json.dumps({"phase": "unavailable", "error": type(error).__name__}))
        return 1
    finally:
        remote.close()
    print(json.dumps(asdict(report), sort_keys=True))
    return 0 if report.verified else 1


if __name__ == "__main__":
    raise SystemExit(main())
