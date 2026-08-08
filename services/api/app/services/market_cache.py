"""
The layer that keeps the request count survivable.

Two caches, because quotes and bars have nothing in common but their source:

- **Quotes live in memory.** They are stale in seconds, so a disk write would
  cost more than the fetch it saves.
- **Bars live on disk**, under `.local-data/bars/`, as the plan's data-plane
  table specifies. Two years of daily candles is stable for hours, expensive to
  refetch, and worth surviving a restart.

Both coalesce: while one caller is fetching a key, the others wait for that
result instead of starting their own. Without it, three panels opening at once
would each ask upstream for the same symbol — and Yahoo counts every one.
"""

import asyncio
import json
import time
from collections.abc import Awaitable, Callable
from dataclasses import asdict
from pathlib import Path
from typing import TypeVar

from app.adapters.models import Bar
from app.config import bars_dir

T = TypeVar("T")


class _Coalescer:
    """One in-flight task per key, shared by everyone who asks for it."""

    def __init__(self) -> None:
        self._inflight: dict[str, asyncio.Task[object]] = {}

    async def run(self, key: str, factory: Callable[[], Awaitable[T]]) -> T:
        existing = self._inflight.get(key)
        if existing is not None:
            # Shielded: a caller giving up must not cancel the fetch the others
            # are still waiting on.
            return await asyncio.shield(existing)  # type: ignore[return-value]

        task: asyncio.Task[T] = asyncio.ensure_future(factory())
        self._inflight[key] = task  # type: ignore[assignment]
        try:
            return await asyncio.shield(task)
        finally:
            # Only clear if it is still ours; a later call may have replaced it.
            if self._inflight.get(key) is task:
                del self._inflight[key]

    @property
    def inflight_count(self) -> int:
        return len(self._inflight)


class MemoryCache:
    """A TTL cache that coalesces. Used for quotes."""

    def __init__(self, ttl: float, *, max_entries: int = 512) -> None:
        self._ttl = ttl
        self._max_entries = max_entries
        self._entries: dict[str, tuple[float, object]] = {}
        self._coalescer = _Coalescer()

    def get(self, key: str) -> object | None:
        entry = self._entries.get(key)
        if entry is None:
            return None
        stored_at, value = entry
        if time.monotonic() - stored_at >= self._ttl:
            del self._entries[key]
            return None
        return value

    def put(self, key: str, value: object) -> None:
        if len(self._entries) >= self._max_entries:
            # Oldest first; insertion order is good enough for a cache this size.
            oldest = next(iter(self._entries))
            del self._entries[oldest]
        self._entries[key] = (time.monotonic(), value)

    async def fetch(self, key: str, factory: Callable[[], Awaitable[T]]) -> T:
        cached = self.get(key)
        if cached is not None:
            return cached  # type: ignore[return-value]

        async def load() -> T:
            value = await factory()
            self.put(key, value)
            return value

        return await self._coalescer.run(key, load)

    def clear(self) -> None:
        self._entries.clear()


class BarCache:
    """
    Bars on disk, one file per symbol and timeframe, with the same coalescing.

    A read that fails for any reason is a miss rather than an error: a corrupt
    or half-written file should cost a refetch, not the page.
    """

    def __init__(self, directory: Path | None = None) -> None:
        self._dir = directory
        self._coalescer = _Coalescer()

    @property
    def directory(self) -> Path:
        return self._dir if self._dir is not None else bars_dir()

    def _path_for(self, symbol: str, timeframe: str) -> Path:
        # A symbol is alphanumeric with the odd dash or dot — BRK.B is a real
        # ticker — so dots stay. Runs of them collapse to one, because a file
        # name should never be able to read like a way out of this directory.
        safe_symbol = "".join(c for c in symbol if c.isalnum() or c in "-._")
        while ".." in safe_symbol:
            safe_symbol = safe_symbol.replace("..", ".")
        safe_symbol = safe_symbol.strip("._-") or "unnamed"

        # The timeframe key already carries the extended suffix when there is
        # one, so the two variants of a series never share a file.
        safe_tf = "".join(c for c in timeframe if c.isalnum()) or "unnamed"
        return self.directory / f"{safe_symbol}.{safe_tf}.json"

    def read(self, symbol: str, timeframe: str, ttl: float) -> list[Bar] | None:
        path = self._path_for(symbol, timeframe)
        try:
            if not path.exists() or time.time() - path.stat().st_mtime >= ttl:
                return None
            payload = json.loads(path.read_text(encoding="utf-8"))
            return [Bar(**row) for row in payload["bars"]]
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def write(self, symbol: str, timeframe: str, bars: list[Bar]) -> None:
        path = self._path_for(symbol, timeframe)
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            # Written beside then moved, so a reader never sees half a file.
            temporary = path.with_suffix(".tmp")
            temporary.write_text(
                json.dumps(
                    {
                        "symbol": symbol,
                        "timeframe": timeframe,
                        "bars": [asdict(bar) for bar in bars],
                    }
                ),
                encoding="utf-8",
            )
            temporary.replace(path)
        except OSError:
            # A cache that cannot write is slow, not broken.
            pass

    async def fetch(
        self,
        symbol: str,
        timeframe: str,
        ttl: float,
        factory: Callable[[], Awaitable[list[Bar]]],
    ) -> list[Bar]:
        cached = self.read(symbol, timeframe, ttl)
        if cached is not None:
            return cached

        async def load() -> list[Bar]:
            bars = await factory()
            self.write(symbol, timeframe, bars)
            return bars

        return await self._coalescer.run(f"{symbol}|{timeframe}", load)
