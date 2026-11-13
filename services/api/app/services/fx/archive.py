"""Bounded, resumable FX replica import, replay and integrity comparison."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Callable, Iterator
from contextlib import AbstractContextManager, nullcontext
from hashlib import sha256
from pathlib import Path
from typing import Any
from uuid import UUID

from .archive_rows import FxKey, canonical_bytes, normalize_row, row_key
from .models import HISTORY_START, SOURCES
from .store import Store


def _identity(store: Store, cloud: Any, operation: str) -> dict[str, Any]:
    try:
        owner = str(UUID(str(cloud.owner_id)))
        endpoint = str(cloud._project_url)
    except (AttributeError, ValueError, TypeError) as exc:
        raise ValueError("invalid FX replica configuration") from exc
    if owner != store.owner_id or not endpoint.startswith("https://"):
        raise ValueError("FX owner or endpoint mismatch")
    return {
        "version": 1,
        "operation": operation,
        "owner_id": owner,
        "endpoint_sha256": sha256(endpoint.encode("utf-8")).hexdigest(),
    }


def _validate_batch_size(batch_size: int) -> None:
    if (
        isinstance(batch_size, bool)
        or not isinstance(batch_size, int)
        or not 1 <= batch_size <= 1000
    ):
        raise ValueError("invalid FX archive batch size")


def _load_checkpoint(path: Path, identity: dict[str, Any]) -> FxKey | None:
    if not path.exists():
        return None
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(body, dict) or set(body) != set(identity) | {"last_key"}:
            raise ValueError
        if any(body.get(key) != value for key, value in identity.items()):
            raise ValueError
        key = body["last_key"]
        if (
            not isinstance(key, list)
            or len(key) != 3
            or not all(isinstance(part, str) for part in key)
            or key[0] not in SOURCES
            or tuple(key)
            != row_key({"source": key[0], "effective_at": key[1], "observed_at": key[2]})
        ):
            raise ValueError
        return key[0], key[1], key[2]
    except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError) as exc:
        raise ValueError("invalid FX archive checkpoint") from exc


def _save_checkpoint(path: Path, identity: dict[str, Any], last_key: FxKey) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    body = {**identity, "last_key": list(last_key)}
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(body, handle, sort_keys=True, separators=(",", ":"))
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
        if os.name != "nt":
            directory = os.open(path.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
    finally:
        Path(temporary).unlink(missing_ok=True)


def import_history(
    store: Store,
    cloud: Any,
    *,
    checkpoint: Path,
    batch_size: int = 500,
    lock: Callable[[], AbstractContextManager[None]] | None = None,
) -> int:
    """Import remote history without queuing it or touching acquisition health."""
    _validate_batch_size(batch_size)
    identity = _identity(store, cloud, "import")
    after = _load_checkpoint(checkpoint, identity)
    scanned = 0
    while page := cloud.list_fx(after=after, limit=batch_size):
        rows = [normalize_row(row, UUID(store.owner_id)) for row in page]
        keys = [row_key(row) for row in rows]
        if len(rows) > batch_size or any(
            key <= prior
            for prior, key in zip([after, *keys], keys, strict=False)
            if prior is not None
        ):
            raise ValueError("invalid FX replica page")
        if any(row["effective_at"] < HISTORY_START.isoformat() for row in rows):
            raise ValueError("FX replica returned pre-boundary history")
        with lock() if lock is not None else nullcontext():
            store.import_rows(rows)
            _save_checkpoint(checkpoint, identity, keys[-1])
        after = keys[-1]
        scanned += len(rows)
        if len(rows) < batch_size:
            break
    return scanned


def replay_history(store: Store, cloud: Any, *, checkpoint: Path, batch_size: int = 500) -> int:
    """Upsert archived rows by full key; remote acceptance precedes cursor write."""
    _validate_batch_size(batch_size)
    identity = _identity(store, cloud, "replay")
    after = _load_checkpoint(checkpoint, identity)
    acknowledged = 0
    while page := store.archive_page(after=after, limit=batch_size):
        last_key = row_key(page[-1])
        retained = [row for row in page if row["effective_at"] >= HISTORY_START.isoformat()]
        if retained and cloud.upsert_fx(retained) != len(retained):
            raise RuntimeError("incomplete FX replica acknowledgement")
        _save_checkpoint(checkpoint, identity, last_key)
        after = last_key
        acknowledged += len(retained)
        if len(page) < batch_size:
            break
    return acknowledged


def _pages(store_or_cloud: Any, *, local: bool, batch_size: int) -> Iterator[dict[str, Any]]:
    after = None
    while True:
        page = (
            store_or_cloud.archive_page(after=after, limit=batch_size)
            if local
            else store_or_cloud.list_fx(after=after, limit=batch_size)
        )
        if not page:
            return
        if len(page) > batch_size:
            raise ValueError("invalid FX replica page")
        for row in page:
            key = row_key(row)
            if after is not None and key <= after:
                raise ValueError("invalid FX replica page order")
            after = key
            yield row
        if len(page) < batch_size:
            return


def compare_history(
    store: Store, cloud: Any, *, batch_size: int = 500
) -> dict[str, dict[str, Any]]:
    """Compare complete keys and contents, without trusting equal row counts."""
    _validate_batch_size(batch_size)
    _identity(store, cloud, "compare")
    hashes = {side: {source: sha256() for source in SOURCES} for side in ("local", "remote")}
    counts = {side: {source: 0 for source in SOURCES} for side in ("local", "remote")}
    older = {source: 0 for source in SOURCES}
    for side, stream in (
        ("local", _pages(store, local=True, batch_size=batch_size)),
        ("remote", _pages(cloud, local=False, batch_size=batch_size)),
    ):
        for raw in stream:
            row = normalize_row(raw, UUID(store.owner_id))
            source = row["source"]
            if row["effective_at"] < HISTORY_START.isoformat():
                if side == "local":
                    older[source] += 1
                    continue
                raise ValueError("FX replica returned pre-boundary history")
            if counts[side][source]:
                hashes[side][source].update(b"\n")
            hashes[side][source].update(canonical_bytes(row))
            counts[side][source] += 1
    return {
        source: {
            "local_count": counts["local"][source],
            "remote_count": counts["remote"][source],
            "local_digest": hashes["local"][source].hexdigest(),
            "remote_digest": hashes["remote"][source].hexdigest(),
            "older_local_count": older[source],
            "matches": older[source] == 0
            and counts["local"][source] == counts["remote"][source]
            and hashes["local"][source].digest() == hashes["remote"][source].digest(),
        }
        for source in SOURCES
    }
