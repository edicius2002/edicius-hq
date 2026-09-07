from __future__ import annotations

import asyncio
import json
import logging
import math
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path

from app.adapters.cnn_sentiment import SentimentProviderError
from app.adapters.sentiment_models import SentimentSnapshot
from app.config import (
    MAX_STALE_SENTIMENT_SECONDS,
    SENTIMENT_TTL_SECONDS,
    sentiment_dir,
)

logger = logging.getLogger(__name__)


class SentimentCache:
    """One coalesced, atomic disk snapshot for CNN's daily sentiment payload."""

    def __init__(self, directory: Path | None = None) -> None:
        self._directory = directory
        self._inflight: asyncio.Task[SentimentSnapshot] | None = None

    @property
    def directory(self) -> Path:
        return self._directory if self._directory is not None else sentiment_dir()

    @property
    def path(self) -> Path:
        return self.directory / "snapshot.json"

    def _read(self, max_age: float) -> SentimentSnapshot | None:
        try:
            path = self.path
            if not path.exists() or time.time() - path.stat().st_mtime >= max_age:
                return None
            snapshot = SentimentSnapshot.from_wire(json.loads(path.read_text(encoding="utf-8")))
            if not self._valid(snapshot):
                return None
            return replace(snapshot, stale=False)
        except (OSError, ValueError, KeyError, TypeError, OverflowError):
            return None

    @staticmethod
    def _valid(snapshot: SentimentSnapshot) -> bool:
        metrics = (snapshot.composite, *snapshot.indicators)
        return (
            snapshot.source == "cnn"
            and len(snapshot.indicators) == 7
            and all(
                metric.key
                and metric.label
                and math.isfinite(metric.score)
                and 0 <= metric.score <= 100
                and metric.series
                and all(series.points for series in metric.series)
                for metric in metrics
            )
        )

    def _write(self, snapshot: SentimentSnapshot) -> None:
        path = self.path
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(replace(snapshot, stale=False).to_wire(), separators=(",", ":")),
                encoding="utf-8",
            )
            temporary.replace(path)
        except OSError as exc:
            logger.warning("sentiment cache write failed: %s", exc)

    async def _refresh(
        self, factory: Callable[[], Awaitable[SentimentSnapshot]]
    ) -> SentimentSnapshot:
        # A caller may have filled the file while this one waited for the task
        # slot. Recheck at the boundary that owns the actual upstream call.
        cached = self._read(SENTIMENT_TTL_SECONDS)
        if cached is not None:
            return cached
        try:
            snapshot = await factory()
        except SentimentProviderError as exc:
            if exc.transient:
                stale = self._read(MAX_STALE_SENTIMENT_SECONDS)
                if stale is not None:
                    logger.warning(
                        "serving stale sentiment after upstream refusal: %s (%s)",
                        exc.code,
                        exc.message,
                    )
                    return stale.as_stale()
            raise
        self._write(snapshot)
        return replace(snapshot, stale=False)

    async def fetch(self, factory: Callable[[], Awaitable[SentimentSnapshot]]) -> SentimentSnapshot:
        cached = self._read(SENTIMENT_TTL_SECONDS)
        if cached is not None:
            return cached

        existing = self._inflight
        if existing is not None:
            return await asyncio.shield(existing)

        task = asyncio.ensure_future(self._refresh(factory))
        self._inflight = task
        try:
            return await asyncio.shield(task)
        finally:
            if self._inflight is task:
                self._inflight = None
