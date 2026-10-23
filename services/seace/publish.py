"""Idempotent Supabase upload for one incremental SEACE source pass."""

import json
from datetime import datetime, timezone

from incremental import record_key, source_date


def stable_key(row, kind):
    key = record_key(row, kind)
    return json.dumps(key, ensure_ascii=False, separators=(",", ":"))


def publish_updates(cloud, region, year, kind, updates, fetched_at, total):
    """Upload rows before the local snapshot checkpoint is advanced."""
    seen_at = datetime.fromisoformat(fetched_at).astimezone(timezone.utc).isoformat()
    rows = []
    for row in updates:
        published = source_date(row.get("published"))
        rows.append({
            "kind": kind,
            "record_key": stable_key(row, kind),
            "region": region,
            "year": year,
            "published_at": published.astimezone(timezone.utc).isoformat() if published else None,
            "payload": row,
            "last_seen_at": seen_at,
        })
    for offset in range(0, len(rows), 100):
        cloud.upsert_seace_records(rows[offset:offset + 100])
    cloud.upsert_seace_sync_state({
        "region": region, "year": year, "kind": kind,
        "fetched_at": seen_at, "record_count": total,
    })
    return len(rows)
