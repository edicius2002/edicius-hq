from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import Awaitable, Callable
from dataclasses import replace
from pathlib import Path

from app.adapters.codex_resets import CodexResetsProviderError, CodexResetsSnapshot
from app.config import CODEX_RESETS_TTL_SECONDS, codex_resets_dir

logger = logging.getLogger(__name__)


class CodexResetsCache:
    """One atomic snapshot, coalesced in memory and durable across API restarts."""

    def __init__(self, directory: Path | None = None) -> None:
        self._directory = directory
        self._inflight: asyncio.Task[CodexResetsSnapshot] | None = None

    @property
    def directory(self) -> Path:
        return self._directory if self._directory is not None else codex_resets_dir()

    @property
    def path(self) -> Path:
        return self.directory / "snapshot.json"

    def _read(self, max_age: float | None) -> CodexResetsSnapshot | None:
        try:
            if not self.path.exists():
                return None
            if max_age is not None and time.time() - self.path.stat().st_mtime >= max_age:
                return None
            snapshot = CodexResetsSnapshot.from_wire(
                json.loads(self.path.read_text(encoding="utf-8"))
            )
            return replace(snapshot, stale=False)
        except (OSError, ValueError, KeyError, TypeError, OverflowError, CodexResetsProviderError):
            return None

    def _write(self, snapshot: CodexResetsSnapshot) -> None:
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(replace(snapshot, stale=False).to_wire(), separators=(",", ":")),
                encoding="utf-8",
            )
            temporary.replace(self.path)
        except OSError as exc:
            logger.warning("Codex Resets cache write failed: %s", exc)

    async def _refresh(
        self,
        factory: Callable[[CodexResetsSnapshot | None], Awaitable[CodexResetsSnapshot]],
    ) -> CodexResetsSnapshot:
        fresh = self._read(CODEX_RESETS_TTL_SECONDS)
        if fresh is not None:
            return fresh
        previous = self._read(None)
        try:
            snapshot = await factory(previous)
        except CodexResetsProviderError as exc:
            if exc.transient and previous is not None:
                logger.warning("serving stale Codex Resets data after %s", exc.code)
                return replace(previous, stale=True)
            raise
        self._write(snapshot)
        return replace(snapshot, stale=False)

    async def fetch(
        self,
        factory: Callable[[CodexResetsSnapshot | None], Awaitable[CodexResetsSnapshot]],
    ) -> CodexResetsSnapshot:
        fresh = self._read(CODEX_RESETS_TTL_SECONDS)
        if fresh is not None:
            return fresh
        if self._inflight is not None:
            return await asyncio.shield(self._inflight)
        task = asyncio.ensure_future(self._refresh(factory))
        self._inflight = task
        try:
            return await asyncio.shield(task)
        finally:
            if self._inflight is task:
                self._inflight = None
