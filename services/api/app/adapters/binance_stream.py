"""
Binance's streaming ticker, for pairs.

The one official, documented socket in this phase — everything else here is an
undocumented endpoint we tolerate. The legacy already streamed crypto this way
(`js/investing/app.js`, the `@ticker` socket) and it was the half it got right.

A pair has no session, so nothing about market hours applies: Binance sends the
same shape at three in the morning as at noon. See plan decision 8.1.
"""

import asyncio
import json
from dataclasses import dataclass

import websockets

from app.adapters.yahoo_stream import Tick

PROVIDER = "binance"
STREAM_BASE = "wss://stream.binance.com:9443/stream"

# The 24h rolling ticker, which is where a pair's price and its change come
# from — the same statistics `binance.fetch_quote` reads over HTTP, so streamed
# and swept values cannot disagree about what they mean.
_STREAM_SUFFIX = "@ticker"


@dataclass(frozen=True, slots=True)
class _Fields:
    symbol: str = "s"
    price: str = "c"
    change_percent: str = "P"
    event_time: str = "E"


FIELDS = _Fields()


def stream_url(symbols: list[str], *, base: str = STREAM_BASE) -> str:
    """
    One combined socket for every pair, rather than one socket each.

    Binance offers both. Combined means a watchlist of ten pairs costs one
    connection, and changing the set costs a reconnect rather than a fan of
    them — the same reasoning that made quotes a batch in decision 8.13.
    """
    names = "/".join(f"{symbol.lower()}{_STREAM_SUFFIX}" for symbol in sorted(symbols))
    return f"{base}?streams={names}"


def parse_tick(message: str) -> Tick | None:
    """
    One frame to a tick, or None if it carries no usable price.

    Combined streams wrap each payload in `{stream, data}`; a single stream
    sends the payload bare. Both are read, so the shape of the URL is not also
    a decision about the parser.
    """
    try:
        envelope = json.loads(message)
    except (ValueError, TypeError):
        return None

    if not isinstance(envelope, dict):
        return None

    payload = envelope.get("data") if "data" in envelope else envelope
    if not isinstance(payload, dict):
        return None

    symbol = payload.get(FIELDS.symbol)
    price = payload.get(FIELDS.price)
    if not isinstance(symbol, str) or price is None:
        return None

    try:
        value = float(price)
    except (TypeError, ValueError):
        return None

    change = payload.get(FIELDS.change_percent)
    try:
        change_percent = float(change) if change is not None else None
    except (TypeError, ValueError):
        change_percent = None

    stamp = payload.get(FIELDS.event_time)

    return Tick(
        symbol=symbol,
        price=value,
        provider=PROVIDER,
        # A pair never closes, so it is always in its regular session. Saying
        # so explicitly keeps the badge from having to special-case crypto.
        market_state="REGULAR",
        change_percent=change_percent,
        time=float(stamp) / 1000 if isinstance(stamp, (int, float)) else None,
    )


class BinanceStream:
    """
    One combined socket, reopened when the followed set changes.

    Binance takes its subscription in the URL, so unlike Yahoo there is no frame
    to send: changing the set means a new connection. That is why the set is
    checked between reads rather than pushed — a reconnect is cheap here and
    happens only when a symbol is actually added or removed.
    """

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
        self._symbols: set[str] = set()
        self._generation = 0

    @property
    def symbols(self) -> set[str]:
        return set(self._symbols)

    async def watch(self, symbols: set[str]) -> None:
        if symbols == self._symbols:
            return
        self._symbols = set(symbols)
        # Read by the loop between frames; bumping it is what makes the current
        # connection stale rather than tearing it down from another task.
        self._generation += 1

    async def ticks(self):
        backoff = 1.0
        while True:
            wanted = sorted(self._symbols)
            if not wanted:
                # Nothing to follow: wait to be given something rather than
                # opening a socket to no streams, which Binance refuses.
                await self._sleep(backoff)
                continue

            generation = self._generation
            try:
                async with self._connect(stream_url(wanted, base=self._base)) as socket:
                    backoff = 1.0
                    async for raw in socket:
                        if self._generation != generation:
                            break
                        tick = parse_tick(raw if isinstance(raw, str) else raw.decode())
                        if tick is not None:
                            yield tick
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001 — any failure is a reconnect
                await self._sleep(backoff)
                backoff = min(backoff * 2, 60.0)
