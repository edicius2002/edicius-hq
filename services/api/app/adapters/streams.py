"""
One stream per provider, behind one object.

`registry` already decides which provider owns a symbol for quotes and bars.
Streaming asks the same question, so it gets the same answer from the same
place — a pair goes to Binance's socket, everything else to Yahoo's, and the
hub above never learns that there is more than one.
"""

import asyncio
from collections.abc import AsyncIterator

from app.adapters import binance, registry
from app.adapters.binance_stream import BinanceStream
from app.adapters.yahoo_stream import Tick, YahooStream


class CompositeStream:
    """
    Splits a followed set by provider and merges the ticks back into one flow.

    Each side reconnects on its own, so Yahoo dropping does not interrupt
    crypto, which never closes and would otherwise go quiet for no reason.
    """

    def __init__(self, *, equities=None, pairs=None) -> None:
        self._equities = equities if equities is not None else YahooStream()
        self._pairs = pairs if pairs is not None else BinanceStream()

    @staticmethod
    def split(symbols: set[str]) -> tuple[set[str], set[str]]:
        pairs = {s for s in symbols if registry.provider_for(s) == binance.PROVIDER}
        return symbols - pairs, pairs

    async def watch(self, symbols: set[str]) -> None:
        equities, pairs = self.split(symbols)
        await asyncio.gather(self._equities.watch(equities), self._pairs.watch(pairs))

    async def ticks(self) -> AsyncIterator[Tick]:
        queue: asyncio.Queue[Tick] = asyncio.Queue()

        async def drain(stream) -> None:
            async for tick in stream.ticks():
                await queue.put(tick)

        tasks = [
            asyncio.create_task(drain(self._equities)),
            asyncio.create_task(drain(self._pairs)),
        ]
        try:
            while True:
                yield await queue.get()
        finally:
            for task in tasks:
                task.cancel()
            await asyncio.gather(*tasks, return_exceptions=True)
