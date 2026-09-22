"""Binance's native kline stream, translated into provider-neutral live bars."""

import asyncio
import json
import logging
import math
from collections.abc import AsyncIterator

import websockets

from app.adapters import binance, registry
from app.adapters.binance_stream import STREAM_BASE
from app.adapters.models import Bar, BarFocus, LiveBar

logger = logging.getLogger(__name__)

PROVIDER = binance.PROVIDER
INTERVALS = frozenset({"1m", "5m", "15m", "1h", "1d", "1w", "1M"})


def stream_url(focuses: set[BarFocus], *, base: str = STREAM_BASE) -> str:
    streams = "/".join(
        f"{focus.symbol.lower()}@kline_{focus.timeframe}"
        for focus in sorted(focuses, key=lambda focus: (focus.symbol, focus.timeframe))
    )
    return f"{base}?streams={streams}"


def parse_kline(message: str) -> LiveBar | None:
    """Translate a bare or combined Binance kline event into a current bar."""
    try:
        envelope = json.loads(message)
        payload = envelope.get("data", envelope)
        kline = payload["k"]
        values = tuple(float(kline[key]) for key in ("o", "h", "l", "c", "v"))
        symbol, timeframe = str(payload["s"]), str(kline["i"])
        start, as_of = int(kline["t"]) // 1000, float(payload["E"]) / 1000
    except (AttributeError, KeyError, TypeError, ValueError, OverflowError):
        return None

    if (
        timeframe not in INTERVALS
        or not math.isfinite(as_of)
        or not all(math.isfinite(value) for value in values)
    ):
        return None

    open_, high, low, close, volume = values
    return LiveBar(
        symbol=symbol.upper(),
        timeframe=timeframe,
        extended=False,
        as_of=as_of,
        bar=Bar(start, open_, high, low, close, volume),
        provider=PROVIDER,
    )


class BinanceBarStream:
    """One combined kline socket, reopened whenever the desired focuses change."""

    def __init__(
        self,
        *,
        base: str = STREAM_BASE,
        connect=None,
        sleep=None,
    ) -> None:
        self._base = base
        self._connect = connect or websockets.connect
        self._sleep = sleep or asyncio.sleep
        self._focuses: set[BarFocus] = set()
        self._generation = 0

    async def watch(self, focuses: set[BarFocus]) -> None:
        desired = {
            BarFocus(registry.normalize_symbol(focus.symbol), focus.timeframe, False)
            for focus in focuses
            if registry.provider_for(focus.symbol) == PROVIDER
        }
        if desired == self._focuses:
            return
        self._focuses = desired
        self._generation += 1

    async def bars(self) -> AsyncIterator[LiveBar]:
        backoff = 1.0
        while True:
            wanted = set(self._focuses)
            if not wanted:
                await self._sleep(backoff)
                continue

            generation = self._generation
            try:
                async with self._connect(stream_url(wanted, base=self._base)) as socket:
                    backoff = 1.0
                    async for raw in socket:
                        if self._generation != generation:
                            break
                        update = parse_kline(raw if isinstance(raw, str) else raw.decode())
                        if update is not None:
                            yield update
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 — any failure is a reconnect
                logger.info("binance bar stream dropped, reconnecting in %.0fs: %s", backoff, error)
                await self._sleep(backoff)
                backoff = min(backoff * 2, 60.0)
