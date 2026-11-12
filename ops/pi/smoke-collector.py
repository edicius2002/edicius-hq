#!/usr/bin/env python3
"""Run and verify one bounded worker smoke without exposing secrets."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

ENV_FILE = Path("/etc/edicius-hq/collectors.env")
REPO_ROOT = Path(__file__).resolve().parents[2]
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


def _timestamp(value: object) -> datetime:
    if not isinstance(value, str):
        raise ValueError("missing timestamp")
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(UTC)


def validate_x_state(
    owner: str,
    cutoff: datetime,
    runs: list[dict[str, Any]],
    posts: list[dict[str, Any]],
) -> dict[str, int]:
    healthy = [
        row
        for row in runs
        if row.get("owner_id") == owner
        and row.get("status") == "complete"
        and _timestamp(row.get("heartbeat_at")) >= cutoff
    ]
    if not healthy:
        raise ValueError("X run did not complete after cutoff")
    if not posts:
        raise ValueError("X smoke found no owner post state")
    return {"runs": len(healthy), "posts": len(posts)}


def validate_market_state(
    owner: str,
    cutoff: datetime,
    requests: list[dict[str, Any]],
    quotes: list[dict[str, Any]],
) -> dict[str, int]:
    if len(requests) != 2 or any(row.get("owner_id") != owner for row in requests):
        raise ValueError("market request owner mismatch")
    by_operation = {row.get("operation"): row for row in requests}
    bars = by_operation.get("market-bars", {}).get("result")
    search = by_operation.get("market-search", {}).get("result")
    if any(row.get("status") != "complete" for row in requests):
        raise ValueError("market request did not complete")
    if not isinstance(bars, dict) or not bars.get("bars"):
        raise ValueError("market bars result is empty")
    if not isinstance(search, dict) or not search.get("results"):
        raise ValueError("market search result is empty")
    fresh = [row for row in quotes if _timestamp(row.get("fetched_at")) >= cutoff]
    if not fresh:
        raise ValueError("market quote is stale")
    return {"requests": len(requests), "quotes": len(fresh)}


def validate_airfare_requests_state(
    owner: str,
    cutoff: datetime,
    runs: list[dict[str, Any]],
) -> dict[str, int]:
    healthy = [
        row
        for row in runs
        if row.get("owner_id") == owner
        and row.get("status") == "complete"
        and _timestamp(row.get("heartbeat_at")) >= cutoff
    ]
    if not healthy:
        raise ValueError("Airfare request worker did not reconcile after cutoff")
    return {"runs": len(healthy)}


def load_env() -> None:
    required = ALLOWED_ENV_NAMES - {"COLLECTOR_DATA_BACKEND", "DATABASE_URL", "AIRFARE_SYNC_BACKEND"}
    if any(not os.environ.get(name) for name in required):
        raise ValueError("collector environment is incomplete")
    if os.getenv("COLLECTOR_DATA_BACKEND", "supabase") == "neon" and not os.getenv("DATABASE_URL"):
        raise ValueError("Neon collector environment is incomplete")


def _rows(
    client: httpx.Client, table: str, params: dict[str, str]
) -> list[dict[str, Any]]:
    response = client.get(table, params=params)
    response.raise_for_status()
    body = response.json()
    if not isinstance(body, list) or any(not isinstance(row, dict) for row in body):
        raise ValueError("Supabase returned invalid smoke state")
    return body


def _run(script: str, *arguments: str) -> None:
    subprocess.run(
        [sys.executable, str(REPO_ROOT / "scripts" / script), *arguments, "--once"],
        cwd=REPO_ROOT,
        check=True,
        timeout=300,
    )


def _neon_smoke(collector: str, owner: str, cutoff: datetime) -> dict[str, int]:
    """Verify a real one-shot worker through owner-scoped Neon SQL reads."""
    import psycopg
    from psycopg.rows import dict_row
    from psycopg.types.json import Jsonb

    sys.path.insert(0, str(REPO_ROOT / "services" / "api"))
    from app.services.neon_collector_cloud import NeonCollectorCloud

    NeonCollectorCloud.from_environment()  # Reject a non-Neon target before any write.
    with psycopg.connect(os.environ["DATABASE_URL"], connect_timeout=15, row_factory=dict_row) as conn:
        if collector == "x-posts":
            _run("tweets-watch.py", "--handle", "thsottiaux")
            runs = list(conn.execute(
                "SELECT owner_id,status,heartbeat_at FROM public.collector_runs "
                "WHERE owner_id=%s::uuid AND collector='x-posts' AND heartbeat_at>=%s",
                (owner, cutoff),
            ).fetchall())
            posts = list(conn.execute(
                "SELECT post_id FROM public.tweet_posts WHERE owner_id=%s::uuid "
                "AND handle='thsottiaux' LIMIT 1", (owner,),
            ).fetchall())
            return validate_x_state(owner, cutoff, _neon_json_rows(runs), posts)
        if collector == "market":
            queued = list(conn.execute(
                "INSERT INTO public.collector_requests(owner_id,operation,payload) VALUES "
                "(%s::uuid,'market-bars',%s::jsonb),(%s::uuid,'market-search',%s::jsonb) "
                "RETURNING request_id",
                (owner, Jsonb({"symbol": "AAPL", "timeframe": "1d", "extended": False}),
                 owner, Jsonb({"query": "Apple"})),
            ).fetchall())
            conn.commit()
            _run("market-worker.py")
            request_ids = [row["request_id"] for row in queued]
            requests = list(conn.execute(
                "SELECT owner_id,operation,status,result FROM public.collector_requests "
                "WHERE owner_id=%s::uuid AND request_id=ANY(%s::uuid[])",
                (owner, request_ids),
            ).fetchall())
            quotes = list(conn.execute(
                "SELECT symbol,fetched_at FROM public.market_quotes "
                "WHERE owner_id=%s::uuid AND fetched_at>=%s", (owner, cutoff),
            ).fetchall())
            return validate_market_state(owner, cutoff, _neon_json_rows(requests), _neon_json_rows(quotes))
        _run("airfare-request-worker.py")
        runs = list(conn.execute(
            "SELECT owner_id,status,heartbeat_at FROM public.collector_runs "
            "WHERE owner_id=%s::uuid AND collector='airfare-requests' AND heartbeat_at>=%s",
            (owner, cutoff),
        ).fetchall())
        return validate_airfare_requests_state(owner, cutoff, _neon_json_rows(runs))


def _neon_json_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return [
        {key: str(value) if key == "owner_id" else value.isoformat() if isinstance(value, datetime) else value
         for key, value in row.items()}
        for row in rows
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("collector", choices=("x-posts", "market", "airfare-requests"))
    parser.add_argument("--cutoff", required=True)
    args = parser.parse_args()
    cutoff = _timestamp(args.cutoff)
    load_env()
    owner = os.environ["EDICIUS_OWNER_ID"]
    if os.getenv("COLLECTOR_DATA_BACKEND", "supabase") == "neon":
        counts = _neon_smoke(args.collector, owner, cutoff)
        print("smoke complete " + " ".join(f"{key}={value}" for key, value in counts.items()))
        return 0
    url = os.environ["SUPABASE_URL"].rstrip("/")
    secret = os.environ["SUPABASE_SECRET_KEY"]
    timeout = float(os.environ["COLLECTOR_SUPABASE_TIMEOUT_SECONDS"])
    headers = {
        "apikey": secret,
        "Authorization": f"Bearer {secret}",
        "Content-Type": "application/json",
    }
    with httpx.Client(
        base_url=f"{url}/rest/v1/",
        headers=headers,
        timeout=timeout,
        trust_env=False,
        follow_redirects=False,
    ) as client:
        if args.collector == "x-posts":
            _run("tweets-watch.py", "--handle", "thsottiaux")
            runs = _rows(
                client,
                "collector_runs",
                {
                    "select": "owner_id,status,heartbeat_at",
                    "owner_id": f"eq.{owner}",
                    "collector": "eq.x-posts",
                    "heartbeat_at": f"gte.{cutoff.isoformat()}",
                },
            )
            posts = _rows(
                client,
                "tweet_posts",
                {
                    "select": "post_id",
                    "owner_id": f"eq.{owner}",
                    "handle": "eq.thsottiaux",
                    "limit": "1",
                },
            )
            counts = validate_x_state(owner, cutoff, runs, posts)
        elif args.collector == "market":
            payload = [
                {
                    "owner_id": owner,
                    "operation": "market-bars",
                    "payload": {"symbol": "AAPL", "timeframe": "1d", "extended": False},
                },
                {
                    "owner_id": owner,
                    "operation": "market-search",
                    "payload": {"query": "Apple"},
                },
            ]
            queued = client.post(
                "collector_requests",
                json=payload,
                headers={"Prefer": "return=representation"},
            )
            queued.raise_for_status()
            request_ids = [row["request_id"] for row in queued.json()]
            _run("market-worker.py")
            requests = _rows(
                client,
                "collector_requests",
                {
                    "select": "owner_id,operation,status,result",
                    "request_id": f"in.({','.join(request_ids)})",
                },
            )
            quotes = _rows(
                client,
                "market_quotes",
                {
                    "select": "symbol,fetched_at",
                    "owner_id": f"eq.{owner}",
                    "fetched_at": f"gte.{cutoff.isoformat()}",
                },
            )
            counts = validate_market_state(owner, cutoff, requests, quotes)
        else:
            _run("airfare-request-worker.py")
            runs = _rows(
                client,
                "collector_runs",
                {
                    "select": "owner_id,status,heartbeat_at",
                    "owner_id": f"eq.{owner}",
                    "collector": "eq.airfare-requests",
                    "heartbeat_at": f"gte.{cutoff.isoformat()}",
                },
            )
            counts = validate_airfare_requests_state(owner, cutoff, runs)
    print(
        "smoke complete " + " ".join(f"{key}={value}" for key, value in counts.items())
    )
    return 0


if __name__ == "__main__":
    import psycopg

    try:
        raise SystemExit(main())
    except (OSError, ValueError, httpx.HTTPError, psycopg.Error, subprocess.SubprocessError):
        print("collector smoke failed", file=sys.stderr)
        raise SystemExit(1) from None
