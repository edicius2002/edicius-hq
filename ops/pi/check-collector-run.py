#!/usr/bin/env python3
"""Check one fresh collector_runs row using the Pi-local secret file only."""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import UTC, datetime
from pathlib import Path

import httpx


ENV_FILE = Path("/etc/edicius-hq/collectors.env")
COLLECTORS = frozenset({"airfare", "sentiment", "x-posts", "market"})
ALLOWED_ENV_NAMES = frozenset(
    {
        "SUPABASE_URL",
        "SUPABASE_SECRET_KEY",
        "EDICIUS_OWNER_ID",
        "COLLECTOR_SUPABASE_TIMEOUT_SECONDS",
        "AIRFARE_DATA_BACKEND",
        "AIRFARE_SYNC_ENABLED",
    }
)
# collector_config validates the locally loaded SUPABASE_SECRET_KEY; it is never printed or parsed as an argument.


def fail(message: str) -> None:
    print(f"edicius collector-run check: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_env() -> None:
    if ENV_FILE.is_symlink() or not ENV_FILE.is_file():
        fail("collector environment file must be a regular file")
    metadata = ENV_FILE.stat()
    if metadata.st_uid != 0:
        fail("collector environment file must be owned by root")
    if metadata.st_gid != 0:
        fail("collector environment file must be owned by root group")
    if metadata.st_mode & 0o777 != 0o600:
        fail("collector environment file must have mode 0600")
    try:
        lines = ENV_FILE.read_text(encoding="utf-8").splitlines()
    except OSError:
        fail("collector environment file is unavailable")
    values: dict[str, str] = {}
    for line in lines:
        if not line or line.startswith("#"):
            continue
        name, separator, value = line.partition("=")
        if not separator or name not in ALLOWED_ENV_NAMES or not value or name in values:
            fail("collector environment file is invalid")
        values[name] = value
    if set(values) != ALLOWED_ENV_NAMES:
        fail("collector environment file is missing a required variable")
    for name in ALLOWED_ENV_NAMES:
        os.environ[name] = values[name]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collector", choices=sorted(COLLECTORS))
    parser.add_argument("--cutoff", required=True)
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=60)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if not 1 <= args.wait_seconds <= 300:
        fail("wait seconds must be between 1 and 300")
    try:
        cutoff = datetime.fromisoformat(args.cutoff.replace("Z", "+00:00")).astimezone(UTC)
    except ValueError:
        fail("cutoff must be an ISO-8601 UTC timestamp")
    load_env()
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "services" / "api"))
    try:
        from app.config import collector_config

        config = collector_config()
        deadline = time.monotonic() + args.wait_seconds
        while True:
            with httpx.Client(trust_env=False, timeout=config.timeout_seconds, follow_redirects=False) as client:
                response = client.get(
                    f"{config.url}/rest/v1/collector_runs",
                    headers={"apikey": config.secret_key, "Authorization": f"Bearer {config.secret_key}"},
                    params={
                        "select": "run_id,status,started_at,completed_at",
                        "owner_id": f"eq.{config.owner_id}",
                        "collector": f"eq.{args.collector}",
                        "started_at": f"gte.{cutoff.isoformat()}",
                        "order": "started_at.desc",
                        "limit": "1",
                    },
                )
            response.raise_for_status()
            rows = response.json()
            if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict):
                status = rows[0].get("status")
                if status == "failed":
                    fail("fresh collector run failed")
                if status in {"running", "complete"} and (not args.require_complete or status == "complete"):
                    print(f"fresh collector run: {args.collector} {status}")
                    return 0
            if time.monotonic() >= deadline:
                fail("no healthy fresh collector run was found before timeout")
            time.sleep(2)
    except (ImportError, ValueError, httpx.HTTPError):
        fail("Supabase collector run query failed")


if __name__ == "__main__":
    raise SystemExit(main())
