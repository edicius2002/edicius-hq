"""Durable acknowledgements for a baseline whose authoritative file can change."""

import hashlib
import json
import os
import re
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path

type BaselineKey = tuple[str, str]

_VERSION = 2
_RECORD_ID = re.compile(r"[0-9a-f]{64}")


class BaselineAcknowledgements:
    """Track the last confirmed content ID per (flight_date, price_date).

    The caller owns one checkpoint path per route and passes a stable remote
    identity, which is stored only as a hash. The caller also
    serializes its entire scan/upload cycle before constructing this object.
    Call ``pending`` before sending any batch, then ``confirm`` only after a
    successful response. A lost response must leave those keys unconfirmed,
    even if the next source version returns to a previously uploaded value.

    The writer cursor fingerprints every persisted baseline cursor for this
    route, including aliases. A legacy writer changes those cursors without
    maintaining this checkpoint, so a mismatch invalidates all previous ACKs.
    The caller commits each cursor before confirming its records here; a crash
    between those writes conservatively replays the route.

    Missing or invalid checkpoints require replay; they never prove an ACK.
    POSIX writes fsync the containing directory after the atomic replacement;
    Windows retains the file fsync and replacement without a directory fsync.
    """

    def __init__(self, path: Path, *, replica_id: str, writer_cursor: str = "") -> None:
        self._path = path
        self._replica_id = hashlib.sha256(replica_id.encode("utf-8")).hexdigest()
        self._writer_cursor = writer_cursor
        self.valid = False
        self._acknowledged = self._load()

    def needed(self, current: Mapping[BaselineKey, str]) -> set[BaselineKey]:
        return {key for key, identity in current.items() if self._acknowledged.get(key) != identity}

    def pending(self, keys: Iterable[BaselineKey]) -> None:
        """Durably invalidate old ACKs before the caller performs remote writes."""
        invalidated = set(keys)
        remaining = {
            key: value for key, value in self._acknowledged.items() if key not in invalidated
        }
        self._persist(remaining)
        self._acknowledged = remaining

    def confirm(
        self, records: Mapping[BaselineKey, str], *, writer_cursor: str | None = None
    ) -> None:
        """Atomically bind confirmed records to the cursor their writer committed."""
        confirmed = {**self._acknowledged, **records}
        cursor = self._writer_cursor if writer_cursor is None else writer_cursor
        self._persist(confirmed, writer_cursor=cursor)
        self._acknowledged = confirmed
        self._writer_cursor = cursor

    def _load(self) -> dict[BaselineKey, str]:
        try:
            document = json.loads(self._path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {}
        if (
            not isinstance(document, dict)
            or not isinstance(document.get("version"), int)
            or isinstance(document.get("version"), bool)
            or document.get("version") != _VERSION
            or document.get("replica_id") != self._replica_id
            or document.get("writer_cursor") != self._writer_cursor
            or not isinstance(document.get("acknowledged"), list)
        ):
            return {}
        acknowledged: dict[BaselineKey, str] = {}
        for row in document["acknowledged"]:
            if (
                not isinstance(row, list)
                or len(row) != 3
                or any(not isinstance(value, str) or not value for value in row)
                or _RECORD_ID.fullmatch(row[2]) is None
            ):
                return {}
            key = (row[0], row[1])
            if key in acknowledged:
                return {}
            acknowledged[key] = row[2]
        self.valid = True
        return acknowledged

    def _persist(
        self, acknowledged: Mapping[BaselineKey, str], *, writer_cursor: str | None = None
    ) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary: Path | None = None
        try:
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                dir=self._path.parent,
                suffix=".tmp",
                delete=False,
            ) as handle:
                temporary = Path(handle.name)
                json.dump(
                    {
                        "version": _VERSION,
                        "replica_id": self._replica_id,
                        "writer_cursor": (
                            self._writer_cursor if writer_cursor is None else writer_cursor
                        ),
                        "acknowledged": [
                            [*key, identity] for key, identity in sorted(acknowledged.items())
                        ],
                    },
                    handle,
                    sort_keys=True,
                )
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, self._path)
            if os.name != "nt":
                directory = os.open(self._path.parent, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
                try:
                    os.fsync(directory)
                finally:
                    os.close(directory)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
