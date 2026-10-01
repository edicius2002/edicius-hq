"""SQLite outbox and scheduling, committed atomically before any cloud write."""

from __future__ import annotations

import json
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any
from uuid import UUID

from .models import Observation


class Store:
    def __init__(self, path: Path, owner_id: UUID):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.owner_id = str(owner_id)
        self.db = sqlite3.connect(path)
        self.db.execute("pragma journal_mode=WAL")
        self.db.execute("pragma synchronous=FULL")
        self.db.executescript("""
          create table if not exists outbox(owner text, source text, effective text, observed text, payload text not null, primary key(owner,source,effective,observed));
          create table if not exists due(owner text, source text, next_at real not null, primary key(owner,source));
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
