"""Merge the provider-specific live-bar sources behind one stream."""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import AsyncIterator, Awaitable, Callable

from app.adapters import registry, yahoo
from app.adapters.binance_bar_stream import BinanceBarStream
from app.adapters.models import BarFocus, LiveBar
from app.adapters.yahoo_live_bars import (
    YahooLiveBarClient,
    seconds_until_yahoo_open,
    yahoo_session_at,
)

logger = logging.getLogger(__name__)


class CompositeBarStream:
    """Merge Binance's socket and Yahoo's polled provisional candles."""

    def __init__(
        self,
        binance: BinanceBarStream,
        yahoo: YahooLiveBarClient,
        *,
        clock: Callable[[], float] = time.time,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        queue_size: int = 128,
    ) -> None:
        if queue_size < 1:
            raise ValueError("queue_size must be positive")
        self._binance = binance
        self._yahoo = yahoo
        self._clock = clock
        self._sleep = sleep
        self._queue: asyncio.Queue[LiveBar] = asyncio.Queue(maxsize=queue_size)
        self._yahoo_tasks: dict[BarFocus, asyncio.Task[None]] = {}
        self._binance_task: asyncio.Task[None] | None = None

    async def watch(self, focuses: set[BarFocus]) -> None:
        """Replace the desired focuses and reconcile each provider source."""
        yahoo_focuses = {
            focus for focus in focuses if registry.provider_for(focus.symbol) == yahoo.PROVIDER
        }
        binance = focuses - yahoo_focuses
        await self._binance.watch(binance)

        for focus in self._yahoo_tasks.keys() - yahoo_focuses:
            self._yahoo_tasks.pop(focus).cancel()
        for focus in yahoo_focuses - self._yahoo_tasks.keys():
            self._yahoo_tasks[focus] = asyncio.create_task(self._poll_yahoo(focus))

    async def _poll_yahoo(self, focus: BarFocus) -> None:
        backoff = 5.0
        while True:
            now = self._clock()
            if yahoo_session_at(int(now)) == "CLOSED":
                await self._sleep(seconds_until_yahoo_open(now))
                continue

            try:
                update = await self._yahoo.fetch(focus)
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 — isolate one Yahoo focus
                logger.info("Yahoo live bar fetch failed for %s: %s", focus.symbol, error)
                await self._sleep(backoff)
                backoff = min(backoff * 2, 60.0)
                continue

            backoff = 5.0
            if update is not None:
                await self._queue.put(update)
            await self._sleep(5.0)

    async def _pump_binance(self) -> None:
        async for update in self._binance.bars():
            await self._queue.put(update)

    async def bars(self) -> AsyncIterator[LiveBar]:
        """Yield whichever provider produces the next live bar."""
        if self._binance_task is None or self._binance_task.done():
            self._binance_task = asyncio.create_task(self._pump_binance())
        try:
            while True:
                yield await self._queue.get()
        finally:
            await self.close()

    async def close(self) -> None:
        """Stop provider tasks owned by this composite stream."""
        tasks = list(self._yahoo_tasks.values())
        self._yahoo_tasks.clear()
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

        binance_task = self._binance_task
        self._binance_task = None
        if binance_task is not None and not binance_task.done():
            binance_task.cancel()
            await asyncio.gather(binance_task, return_exceptions=True)


__all__ = ["CompositeBarStream"]
