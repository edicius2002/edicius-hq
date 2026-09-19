"""Replay the local X JSONL outbox to the collector-cloud boundary."""

from __future__ import annotations

import json
import os
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any

from app.services.collector_cloud import (
    CollectorCloud,
    CollectorCloudRejected,
    CollectorCloudUnavailable,
)


class TweetReplica:
    """Acknowledge JSONL bytes only after their deterministic cloud upsert."""

    def __init__(self, archive_path: Path, cloud: CollectorCloud, *, batch_size: int = 100) -> None:
        if batch_size < 1:
            raise ValueError("tweet replica batch size must be positive")
        self.archive_path = archive_path
        self.cloud = cloud
        self.batch_size = batch_size
        self.cursor_path = archive_path.parent / f"{archive_path.stem}.supabase-cursor.json"

    def replay(self, handle: str) -> int:
        """Upsert complete, unacknowledged archive lines and persist each ack."""
        if not self.archive_path.exists():
            return 0
        offset = self._acknowledged_offset()
        written = 0
        batch: list[dict[str, Any]] = []
        batch_end = offset
        with self.archive_path.open("rb") as archive:
            archive.seek(offset)
            while line := archive.readline():
                line_end = archive.tell()
                if not line.endswith(b"\n"):
                    break
                row = self._decode_line(line)
                if row is None:
                    if batch:
                        self._upsert_and_ack(batch, batch_end)
                        written += len(batch)
                        batch = []
                    self._write_cursor(line_end)
                    continue
                batch.append(self._cloud_row(handle, row))
                batch_end = line_end
                if len(batch) == self.batch_size:
                    self._upsert_and_ack(batch, batch_end)
                    written += len(batch)
                    batch = []
            if batch:
                self._upsert_and_ack(batch, batch_end)
                written += len(batch)
        return written

    def append_and_sync(self, handle: str, rows: list[dict[str, Any]]) -> int:
        """Append unseen records before replaying them; the archive is the authority."""
        fresh = self.fresh_rows(handle, rows)
        if fresh:
            self._append(fresh)
        self.replay(handle)
        return len(fresh)

    def fresh_rows(self, _handle: str, rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Deduplicate by post id against retained JSONL, including this capture."""
        known = self._known_ids()
        fresh: list[dict[str, Any]] = []
        for row in rows:
            post_id = row.get("id")
            if not isinstance(post_id, (str, int)) or not str(post_id) or str(post_id) in known:
                continue
            known.add(str(post_id))
            fresh.append(row)
        return fresh

    def _acknowledged_offset(self) -> int:
        try:
            cursor = json.loads(self.cursor_path.read_text(encoding="utf-8"))
            stat = self.archive_path.stat()
            if (
                cursor["identity"] == [stat.st_dev, stat.st_ino]
                and isinstance(cursor["offset"], int)
                and 0 <= cursor["offset"] <= stat.st_size
            ):
                return cursor["offset"]
        except (FileNotFoundError, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            pass
        return 0

    def _write_cursor(self, offset: int) -> None:
        stat = self.archive_path.stat()
        self.cursor_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.cursor_path.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"identity": [stat.st_dev, stat.st_ino], "offset": offset}), encoding="utf-8"
        )
        os.replace(temporary, self.cursor_path)

    def _upsert_and_ack(self, batch: list[dict[str, Any]], offset: int) -> None:
        try:
            self.cloud.upsert_tweets(batch)
        except CollectorCloudUnavailable:
            raise CollectorCloudUnavailable("tweet replica sync unavailable") from None
        except CollectorCloudRejected:
            raise CollectorCloudRejected("tweet replica sync rejected") from None
        self._write_cursor(offset)

    @staticmethod
    def _decode_line(line: bytes) -> dict[str, Any] | None:
        try:
            row = json.loads(line)
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None
        return row if isinstance(row, dict) else None

    def _known_ids(self) -> set[str]:
        if not self.archive_path.exists():
            return set()
        known: set[str] = set()
        with self.archive_path.open("rb") as archive:
            for line in archive:
                row = self._decode_line(line)
                if row is not None and isinstance(row.get("id"), (str, int)):
                    known.add(str(row["id"]))
        return known

    def _append(self, rows: list[dict[str, Any]]) -> None:
        self.archive_path.parent.mkdir(parents=True, exist_ok=True)
        with self.archive_path.open("a", encoding="utf-8") as archive:
            for row in rows:
                archive.write(json.dumps(row, ensure_ascii=False) + "\n")
            archive.flush()
            os.fsync(archive.fileno())

    def _cloud_row(self, handle: str, row: dict[str, Any]) -> dict[str, Any]:
        post_id = str(row.get("id", ""))
        if not post_id:
            raise CollectorCloudRejected("invalid tweet outbox row")
        posted_at = row.get("date")
        if not isinstance(posted_at, str):
            raise CollectorCloudRejected("invalid tweet outbox row")
        try:
            parsedate_to_datetime(posted_at)
        except (TypeError, ValueError):
            try:
                from datetime import datetime

                datetime.fromisoformat(posted_at.replace("Z", "+00:00"))
            except ValueError:
                raise CollectorCloudRejected("invalid tweet outbox row") from None
        return {
            "owner_id": str(self.cloud.owner_id),
            "handle": handle.lstrip("@"),
            "post_id": post_id,
            "posted_at": posted_at,
            "payload": row,
        }
