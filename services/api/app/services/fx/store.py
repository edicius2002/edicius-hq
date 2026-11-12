"""Durable SQLite archive, replication outbox, and atomic source scheduling."""

from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from datetime import UTC, datetime
from decimal import Decimal
from pathlib import Path
from typing import Any
from uuid import UUID

from .archive_rows import FxKey, canonical_bytes, normalize_row, row_key
from .models import Observation


class Store:
    def __init__(self, path: Path, owner_id: UUID, *, readonly: bool = False):
        self.owner_id = str(UUID(str(owner_id)))
        self.path = path.resolve()
        if readonly:
            self.db = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.execute("pragma journal_mode=WAL")
        self.db.execute("pragma synchronous=FULL")
        self.db.executescript("""
          create table if not exists outbox(owner text, source text, effective text, observed text, payload text not null, primary key(owner,source,effective,observed));
          create table if not exists observations(owner text, source text, effective text, observed text, payload text not null, primary key(owner,source,effective,observed));
          create table if not exists due(owner text, source text, next_at real not null, primary key(owner,source));
          create table if not exists source_health(
            owner text not null, source text not null, last_attempt real not null,
            last_success real, last_error text, consecutive_failures integer not null,
            primary key(owner,source)
          );
        """)
        # The old queue may include pre-boundary rows. Preserve every observation;
        # history policy belongs to acquisition/replay, not this migration.
        with self.db:
            queued = self.db.execute(
                "select source,effective,observed,payload from outbox where owner=?",
                (self.owner_id,),
            ).fetchall()
            for source, effective, observed, payload in queued:
                row = normalize_row(json.loads(payload, parse_float=Decimal), UUID(self.owner_id))
                key = row_key(row)
                self._archive(row)
                self.db.execute(
                    "delete from outbox where owner=? and source=? and effective=? and observed=?",
                    (self.owner_id, source, effective, observed),
                )
                self._enqueue(key)

    def _archive(self, row: dict[str, Any]) -> int:
        return self.db.execute(
            "insert or ignore into observations values(?,?,?,?,?)",
            (self.owner_id, *row_key(row), canonical_bytes(row).decode("utf-8")),
        ).rowcount

    def _enqueue(self, key: FxKey) -> None:
        # A duplicate key always replicates the immutable archived content.
        self.db.execute(
            """insert or ignore into outbox
            select owner,source,effective,observed,payload from observations
            where owner=? and source=? and effective=? and observed=?""",
            (self.owner_id, *key),
        )

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
                row = normalize_row(
                    {**observation.wire(), "owner_id": self.owner_id}, UUID(self.owner_id)
                )
                self._archive(row)
                self._enqueue(row_key(row))
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
        rows = [
            json.loads(r[0])
            for r in self.db.execute(
                "select payload from outbox where owner=? order by observed,source,effective limit ?",
                (self.owner_id, limit),
            )
        ]
        # Retain the established RPC wire shape (omit zero fractional seconds).
        for row in rows:
            for field in ("effective_at", "observed_at"):
                row[field] = datetime.fromisoformat(row[field]).isoformat()
        return rows

    def acknowledge(self, rows: list[dict[str, Any]]) -> None:
        with self.db:
            self.db.executemany(
                "delete from outbox where owner=? and source=? and effective=? and observed=?",
                [(self.owner_id, *row_key(normalize_row(r, UUID(self.owner_id)))) for r in rows],
            )

    def archive_page(self, *, after: FxKey | None = None, limit: int = 500) -> list[dict[str, Any]]:
        if limit <= 0:
            raise ValueError("archive page limit must be positive")
        sql = "select payload from observations where owner=?"
        args: list[Any] = [self.owner_id]
        if after is not None:
            sql += " and (source,effective,observed) > (?,?,?)"
            args.extend(after)
        sql += " order by source,effective,observed limit ?"
        args.append(limit)
        return [json.loads(r[0]) for r in self.db.execute(sql, args)]

    def import_rows(self, rows: list[dict[str, Any]]) -> int:
        with self.db:
            return sum(self._archive(normalize_row(row, UUID(self.owner_id))) for row in rows)

    def latest(self, source: str, *, effective_at: datetime | None = None) -> dict[str, Any] | None:
        sql = "select payload from observations where owner=? and source=?"
        args: list[Any] = [self.owner_id, source]
        if effective_at is not None:
            key = row_key(dict(source=source, effective_at=effective_at, observed_at=effective_at))
            sql += " and effective=?"
            args.append(key[1])
        sql += " order by observed desc,effective desc limit 1"
        result = self.db.execute(sql, args).fetchone()
        return json.loads(result[0]) if result else None

    def backup(self, destination: Path) -> None:
        if destination.resolve() == self.path or destination.exists():
            raise ValueError("backup destination must be new and distinct from the live database")
        # Exclusive creation prevents a concurrent caller from overwriting a backup.
        try:
            with destination.open("xb"):
                pass
        except FileExistsError as exc:
            raise ValueError("backup destination already exists") from exc
        try:
            with closing(sqlite3.connect(destination)) as target:
                self.db.backup(target)
        except BaseException:
            destination.unlink(missing_ok=True)
            raise
