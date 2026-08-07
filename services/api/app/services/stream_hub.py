"""
One upstream connection, however many browser tabs are listening.

Every tab opening its own socket to Yahoo would put the provider's name in the
client, which decision 8.3 forbids, and would multiply a connection that costs
the same whether one page or ten is watching. So the hub owns the connections,
counts who wants which symbol, and fans ticks out to the tabs that asked.

It also coalesces. A tick is worth showing; sixty ticks of the same symbol in a
second are worth one. Each listener keeps only the newest price per symbol
between flushes, so a busy open costs one message per symbol per interval
instead of one per trade.
"""

import asyncio
import contextlib
from collections import Counter
from collections.abc import AsyncIterator

from app.adapters.yahoo_stream import Tick

# How often a listener is flushed. Fast enough to read as live, slow enough
# that a symbol trading hard cannot turn into a render per trade.
FLUSH_SECONDS = 0.25


def _same_reading(before: Tick | None, now: Tick) -> bool:
    """Everything a row displays, which is everything except when it happened."""
    if before is None:
        return False
    return (
        before.price == now.price
        and before.change_percent == now.change_percent
        and before.market_state == now.market_state
    )


class _Listener:
    """
    One browser tab's view: which symbols it wants, and what is owed to it.

    Pending ticks are held in a dict keyed by symbol rather than a queue, so an
    unread tick is replaced by a newer one instead of queueing behind it. A slow
    reader falls behind in time, never in truth.
    """

    def __init__(self, symbols: set[str]) -> None:
        self.symbols = set(symbols)
        self._pending: dict[str, Tick] = {}
        self._last: dict[str, Tick] = {}
        self._ready = asyncio.Event()
        self._closed = False

    def offer(self, tick: Tick) -> None:
        if self._closed or tick.symbol not in self.symbols:
            return
        # Binance's rolling ticker sends every second whether or not anything
        # traded, so most of what arrives at three in the morning is the price
        # we already showed. Repeating it costs bytes and a render and tells
        # the reader nothing; the timestamp alone moving is not news.
        if _same_reading(self._last.get(tick.symbol), tick):
            return
        self._last[tick.symbol] = tick
        self._pending[tick.symbol] = tick
        self._ready.set()

    def close(self) -> None:
        self._closed = True
        self._ready.set()

    async def drain(self) -> list[Tick]:
        """Waits for something to say, then says all of it at once."""
        await self._ready.wait()
        self._ready.clear()
        batch = list(self._pending.values())
        self._pending.clear()
        return batch

    @property
    def closed(self) -> bool:
        return self._closed


class StreamHub:
    """
    Refcounts symbols across listeners and keeps the upstreams in step.

    The upstream is asked to watch the union of what every listener wants. A
    symbol is dropped upstream only when the last listener that wanted it has
    gone, so two tabs on the same watchlist cost one subscription.
    """

    def __init__(self, *, flush_seconds: float = FLUSH_SECONDS) -> None:
        self._listeners: set[_Listener] = set()
        self._wanted: Counter[str] = Counter()
        self._flush_seconds = flush_seconds
        self._lock = asyncio.Lock()
        self._pump: asyncio.Task | None = None
        self._stream = None

    @property
    def symbols(self) -> set[str]:
        """The union every listener adds up to."""
        return {symbol for symbol, count in self._wanted.items() if count > 0}

    @property
    def listener_count(self) -> int:
        return len(self._listeners)

    def attach(self, stream) -> None:
        """
        The upstream to keep in step. Injected rather than constructed here so
        the hub can be tested with something that never opens a socket.
        """
        self._stream = stream

    def publish(self, tick: Tick) -> None:
        """A tick from upstream, offered to everyone who asked for that symbol."""
        for listener in self._listeners:
            listener.offer(tick)

    async def _sync_upstream(self) -> None:
        if self._stream is not None:
            await self._stream.watch(self.symbols)

    async def listen(self, symbols: set[str]) -> AsyncIterator[list[Tick]]:
        """
        Batches of ticks for one listener, until it goes away.

        Yields lists rather than single ticks because the flush is the point:
        everything that happened in the last interval arrives together, and the
        client renders once for the lot.
        """
        listener = _Listener(symbols)

        async with self._lock:
            self._listeners.add(listener)
            self._wanted.update(symbols)
            await self._sync_upstream()

        try:
            while True:
                batch = await listener.drain()
                if listener.closed:
                    return
                if batch:
                    yield batch
                # Rate limit after yielding, not before: the first tick reaches
                # the page immediately, and only a second one within the window
                # waits for it.
                await asyncio.sleep(self._flush_seconds)
        finally:
            async with self._lock:
                self._listeners.discard(listener)
                self._wanted.subtract(listener.symbols)
                self._wanted += Counter()  # drops the symbols that reached zero
                await self._sync_upstream()

    async def pump(self) -> None:
        """Reads the upstream forever, publishing what it says."""
        if self._stream is None:
            return
        async for tick in self._stream.ticks():
            self.publish(tick)

    def start(self) -> None:
        if self._pump is None or self._pump.done():
            self._pump = asyncio.create_task(self.pump())

    async def stop(self) -> None:
        if self._pump is None:
            return
        self._pump.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self._pump
        self._pump = None
        for listener in list(self._listeners):
            listener.close()


HUB = StreamHub()
