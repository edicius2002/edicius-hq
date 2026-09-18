"""Last-known-good owner documents used by Pi collectors."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Protocol

from app.services.collector_cloud import CollectorCloudUnavailable
from app.services.kv_store import _write_atomically


class InvalidWatchDocument(ValueError):
    """The watch document is absent or does not have the collector's shape."""


class WatchCloud(Protocol):
    def document(self, key: str) -> dict[str, Any] | None: ...


def _validated(document: object) -> dict[str, Any]:
    if not isinstance(document, dict):
        raise InvalidWatchDocument("airfare watch document must be an object")
    routes = document.get("routes")
    if not isinstance(routes, list) or any(not isinstance(route, dict) for route in routes):
        raise InvalidWatchDocument("airfare watch document routes must be an array of objects")
    return document


class CloudWatchDocument:
    """Refresh one cloud-owned watch, preserving a valid last-known-good copy."""

    def __init__(self, cloud: WatchCloud, cache_path: Path, *, key: str = "airfare-routes") -> None:
        self._cloud = cloud
        self._cache_path = cache_path
        self._key = key

    def load(self) -> dict[str, Any]:
        try:
            document = _validated(self._cloud.document(self._key))
        except CollectorCloudUnavailable:
            return self._load_cached()

        self._cache_path.parent.mkdir(parents=True, exist_ok=True)
        _write_atomically(self._cache_path, json.dumps(document, ensure_ascii=True, indent=2))
        return document

    def _load_cached(self) -> dict[str, Any]:
        try:
            return _validated(json.loads(self._cache_path.read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError) as error:
            raise InvalidWatchDocument("airfare watch cache is not valid") from error
