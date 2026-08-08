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
from collections.abc import AsyncGenerator, AsyncIterator
from typing import Protocol

from app.adapters.models import Tick


class Upstream(Protocol):
    """
    What the hub needs of a provider's socket.

    Declared here, by the consumer, rather than imported from an adapter: the
    hub must not depend on which provider it is talking to (decision 8.3), and
    `_stream` was previously left unannotated — so mypy inferred `None` from
    the constructor and considered every line that used it unreachable. The
    whole upstream integration was invisible to the type checker.
    """

    async def watch(self, symbols: set[str]) -> None: ...

    def ticks(self) -> AsyncIterator[Tick]: ...


# How often a listener is flushed. Fast enough to read as live, slow enough
# that a symbol trading hard cannot turn into a render per trade.
FLUSH_SECONDS = 0.25

# How long a listener waits before saying "still here" with nothing to report.
# Long enough that a busy market never reaches it, short enough that a proxy
# watching for bytes does not give up first.
KEEPALIVE_SECONDS = 20.0


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

    async def drain(self, timeout: float | None = None) -> list[Tick]:
        """
        Waits for something to say, then says all of it at once.

        An empty list means "nothing within `timeout`" — a keep-alive, not a
        reason to stop.

        The timeout lives *here* rather than around the generator, and that is
        the whole point of this method taking one. `asyncio.wait_for` wrapped
        around `anext(listener)` delivers its cancellation **into** the
        generator, which runs the `finally` in `listen` and unsubscribes: every
        quiet interval tore the listener down, the browser reconnected, and a
        still market cost about 150 full cycles an hour. Cancelling an
        `Event.wait` instead costs nothing.
        """
        try:
            await asyncio.wait_for(self._ready.wait(), timeout)
        except TimeoutError:
            return []

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

    def __init__(
        self,
        *,
        flush_seconds: float = FLUSH_SECONDS,
        keepalive_seconds: float = KEEPALIVE_SECONDS,
    ) -> None:
        self._listeners: set[_Listener] = set()
        self._wanted: Counter[str] = Counter()
        self._flush_seconds = flush_seconds
        self._keepalive_seconds = keepalive_seconds
        self._lock = asyncio.Lock()
        self._pump: asyncio.Task[None] | None = None
        self._stream: Upstream | None = None

    @property
    def symbols(self) -> set[str]:
        """The union every listener adds up to."""
        return {symbol for symbol, count in self._wanted.items() if count > 0}

    @property
    def listener_count(self) -> int:
        return len(self._listeners)

    def attach(self, stream: Upstream) -> None:
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

    async def listen(self, symbols: set[str]) -> AsyncGenerator[list[Tick], None]:
        """
        Batches of ticks for one listener, until it goes away.

        Yields lists rather than single ticks because the flush is the point:
        everything that happened in the last interval arrives together, and the
        client renders once for the lot.

        An **empty list is a keep-alive**: nothing traded for a while and the
        connection is still good. The caller turns it into whatever its
        transport needs. Nothing about a quiet market ends this generator.
        """
        listener = _Listener(symbols)

        async with self._lock:
            self._listeners.add(listener)
            self._wanted.update(symbols)
            await self._sync_upstream()

        try:
            while True:
                batch = await listener.drain(self._keepalive_seconds)
                if listener.closed:
                    return
                yield batch
                # Rate limit after a real batch only. Pausing after a
                # keep-alive would delay the next genuine tick by a window it
                # did nothing to earn.
                if batch:
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
