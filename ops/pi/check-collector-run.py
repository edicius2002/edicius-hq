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
COLLECTORS = frozenset(
    {"airfare", "airfare-requests", "sentiment", "x-posts", "market", "fx"}
)
ALLOWED_ENV_NAMES = frozenset(
    {
        "SUPABASE_URL",
        "SUPABASE_SECRET_KEY",
        "EDICIUS_OWNER_ID",
        "COLLECTOR_SUPABASE_TIMEOUT_SECONDS",
        "AIRFARE_DATA_BACKEND",
        "AIRFARE_SYNC_ENABLED",
        "COLLECTOR_DATA_BACKEND",
        "DATABASE_URL",
        "AIRFARE_SYNC_BACKEND",
    }
)
# The root-owned file is read only by this verification process.


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
    required = ALLOWED_ENV_NAMES - {"COLLECTOR_DATA_BACKEND", "DATABASE_URL", "AIRFARE_SYNC_BACKEND"}
    if not required <= values.keys() or (
        values.get("COLLECTOR_DATA_BACKEND", "supabase") == "neon" and "DATABASE_URL" not in values
    ):
        fail("collector environment file is missing a required variable")
    for name, value in values.items():
        os.environ[name] = value


def neon_run_rows(owner_id: object, collector: str, cutoff: datetime, *, require_complete: bool) -> list[dict]:
    """Read the same fresh owner run from Neon without exposing the connection URL."""
    import psycopg
    from app.services.neon_collector_cloud import NeonCollectorCloud
    from psycopg.rows import dict_row

    cloud = NeonCollectorCloud.from_environment()
    freshness = "started_at" if require_complete else "heartbeat_at"
    query = (
        "SELECT run_id,status,started_at,heartbeat_at,completed_at "
        "FROM public.collector_runs WHERE owner_id=%s::uuid AND collector=%s "
        f"AND {freshness}>=%s::timestamptz ORDER BY started_at DESC LIMIT 1"
    )
    try:
        with psycopg.connect(cloud._database_url, connect_timeout=15, row_factory=dict_row) as conn:
            return list(conn.execute(query, (str(owner_id), collector, cutoff)).fetchall())
    except psycopg.Error:
        fail("Neon collector run query failed")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collector", choices=sorted(COLLECTORS))
    parser.add_argument("--cutoff", required=True)
    parser.add_argument("--require-complete", action="store_true")
    parser.add_argument("--wait-seconds", type=int, default=60)
    return parser.parse_args()


def run_query_params(
    owner_id: object, collector: str, cutoff: datetime, *, require_complete: bool
) -> dict[str, str]:
    params = {
        "select": "run_id,status,started_at,heartbeat_at,completed_at",
        "owner_id": f"eq.{owner_id}",
        "collector": f"eq.{collector}",
        "order": "started_at.desc",
        "limit": "1",
    }
    freshness_column = "started_at" if require_complete else "heartbeat_at"
    params[freshness_column] = f"gte.{cutoff.isoformat()}"
    return params


def is_healthy_status(status: object, *, require_complete: bool) -> bool:
    return status == ("complete" if require_complete else "running")


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

        backend = os.getenv("COLLECTOR_DATA_BACKEND", "supabase")
        config = collector_config() if backend == "supabase" else None
        if backend not in {"supabase", "neon"}:
            fail("invalid collector backend")
        deadline = time.monotonic() + args.wait_seconds
        while True:
            if backend == "neon":
                rows = neon_run_rows(
                    os.environ["EDICIUS_OWNER_ID"], args.collector, cutoff,
                    require_complete=args.require_complete,
                )
            else:
                assert config is not None
                with httpx.Client(trust_env=False, timeout=config.timeout_seconds, follow_redirects=False) as client:
                    response = client.get(
                        f"{config.url}/rest/v1/collector_runs",
                        headers={"apikey": config.secret_key, "Authorization": f"Bearer {config.secret_key}"},
                        params=run_query_params(
                            config.owner_id, args.collector, cutoff,
                            require_complete=args.require_complete,
                        ),
                    )
                response.raise_for_status()
                rows = response.json()
            if isinstance(rows, list) and len(rows) == 1 and isinstance(rows[0], dict):
                status = rows[0].get("status")
                if status == "failed":
                    fail("fresh collector run failed")
                if is_healthy_status(status, require_complete=args.require_complete):
                    print(f"fresh collector run: {args.collector} {status}")
                    return 0
            if time.monotonic() >= deadline:
                fail("no healthy fresh collector run was found before timeout")
            time.sleep(2)
    except (ImportError, ValueError, httpx.HTTPError):
        fail("collector run query failed")


if __name__ == "__main__":
    raise SystemExit(main())
