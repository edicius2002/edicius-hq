"""SQLite outbox and scheduling, committed atomically before any cloud write."""

from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from .models import Observation


class Store:
    def __init__(self, path: Path, owner_id: UUID, *, readonly: bool = False):
        self.owner_id = str(owner_id)
        if readonly:
            self.db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("pragma journal_mode=WAL")
        self.db.execute("pragma synchronous=FULL")
        self.db.executescript("""
          create table if not exists outbox(owner text, source text, effective text, observed text, payload text not null, primary key(owner,source,effective,observed));
          create table if not exists due(owner text, source text, next_at real not null, primary key(owner,source));
          create table if not exists source_health(
            owner text not null, source text not null, last_attempt real not null,
            last_success real, last_error text, consecutive_failures integer not null,
            primary key(owner,source)
          );
        """)

    def __enter__(self) -> Store:
        return self

    def __exit__(self, *args: Any) -> None:
        self.db.close()

    def due(self, source: str, now: datetime) -> bool:
        row = self.db.execute(
            "select next_at from due where owner=? and source=?",
            (self.owner_id, source),
        ).fetchone()
        return row is None or row[0] <= now.timestamp()

    def save(
        self,
        source: str,
        rows: list[Observation],
        next_at: datetime,
        *,
        attempted_at: datetime | None = None,
        error_code: str | None = None,
    ) -> None:
        with self.db:
            for observation in rows:
                row = {**observation.wire(), "owner_id": self.owner_id}
                self.db.execute(
                    "insert or ignore into outbox values(?,?,?,?,?)",
                    (
                        self.owner_id,
                        row["source"],
                        row["effective_at"],
                        row["observed_at"],
                        json.dumps(row),
                    ),
                )
            self.db.execute(
                "insert into due values(?,?,?) on conflict(owner,source) do update set next_at=excluded.next_at",
                (self.owner_id, source, next_at.timestamp()),
            )
            if attempted_at is not None:
                self.db.execute(
                    """insert into source_health values(?,?,?,?,?,?)
                    on conflict(owner,source) do update set
                      last_attempt=excluded.last_attempt,
                      last_success=case when excluded.last_error is null
                        then excluded.last_success else source_health.last_success end,
                      last_error=excluded.last_error,
                      consecutive_failures=case when excluded.last_error is null
                        then 0 else source_health.consecutive_failures+1 end""",
                    (
                        self.owner_id,
                        source,
                        attempted_at.timestamp(),
                        attempted_at.timestamp() if error_code is None else None,
                        error_code,
                        int(error_code is not None),
                    ),
                )

    def status(self, source: str) -> dict[str, Any]:
        due = self.db.execute(
            "select next_at from due where owner=? and source=?", (self.owner_id, source)
        ).fetchone()
        health = self.db.execute(
            """select last_attempt,last_success,last_error,consecutive_failures
            from source_health where owner=? and source=?""",
            (self.owner_id, source),
        ).fetchone()

        def timestamp(value: float | None) -> datetime | None:
            return datetime.fromtimestamp(value, UTC) if value is not None else None

        return {
            "source": source,
            "last_attempt": timestamp(health[0]) if health else None,
            "last_success": timestamp(health[1]) if health else None,
            "last_error": health[2] if health else None,
            "consecutive_failures": health[3] if health else 0,
            "next_due": timestamp(due[0]) if due else None,
        }

    def pending(self, limit: int = 500) -> list[dict[str, Any]]:
        return [
            json.loads(r[0])
            for r in self.db.execute(
                "select payload from outbox where owner=? order by observed,source,effective limit ?",
                (self.owner_id, limit),
            )
        ]

    def acknowledge(self, rows: list[dict[str, Any]]) -> None:
        with self.db:
            self.db.executemany(
                "delete from outbox where owner=? and source=? and effective=? and observed=?",
                [(self.owner_id, r["source"], r["effective_at"], r["observed_at"]) for r in rows],
            )
