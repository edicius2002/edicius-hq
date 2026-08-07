"""
Yahoo's streaming quotes, pushed instead of asked for.

Polling has a floor no cadence can go under: the freshest a price can be is one
interval old, which overnight is a minute. This removes that floor — and the
requests with it — by holding one socket open and letting the exchange decide
when there is something to say.

**It does not replace the poll.** Measured against the ten real watchlist
symbols in pre-market, three of them pushed nothing at all in 32 seconds: the
socket carries trades, not a heartbeat, so silence means "nothing traded" and
"the connection died" in the same breath. It also never sends a previous close,
a name or a currency — the fields a row and its percentage are built from. The
sweep in `registry` remains load-bearing; see plan decision 8.18.
"""

import asyncio
import contextlib
import json
import logging
from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass

import websockets

from app.adapters.wire import WireError, as_float, as_text, read_base64_message, zigzag

logger = logging.getLogger(__name__)

PROVIDER = "yahoo"
STREAM_URL = "wss://streamer.finance.yahoo.com/?version=2"

# Field numbers in Yahoo's pricing message, confirmed against live frames rather
# than a published schema — there isn't one. Only the fields used are named; the
# rest are read and ignored, which is what `wire` leaves us free to do.
_ID = 1
_PRICE = 2
_TIME = 3
_EXCHANGE = 5
_MARKET_HOURS = 7
_CHANGE_PERCENT = 8

# The values seen in field 7. Yahoo's own words for its sessions; 1 is the
# regular one, and crypto — which never closes — reports it around the clock.
MARKET_HOURS = {
    0: "PRE",
    1: "REGULAR",
    2: "POST",
    3: "EXTENDED",
    4: "PRE",
}

# Long enough that a flapping upstream is not hammered, short enough that a
# blip does not leave the page on the sweep for minutes.
_BACKOFF_START = 1.0
_BACKOFF_MAX = 60.0
_BACKOFF_FACTOR = 2.0


@dataclass(frozen=True, slots=True)
class Tick:
    """One price, as the socket reports it. Deliberately thinner than a Quote."""

    symbol: str
    price: float
    provider: str = PROVIDER
    #: Yahoo's own name for the session this trade happened in.
    market_state: str | None = None
    change_percent: float | None = None
    #: Seconds since the epoch, as the exchange stamped it.
    time: float | None = None


def parse_tick(message: str) -> Tick | None:
    """
    One frame to a tick, or None if it carries no usable price.

    Returning None rather than raising: a frame we cannot read is a reason to
    ignore that frame, not to tear down a connection that is otherwise fine.
    """
    try:
        envelope = json.loads(message)
    except (ValueError, TypeError):
        return None

    if not isinstance(envelope, dict):
        return None

    payload = envelope.get("message")
    if not isinstance(payload, str):
        return None

    try:
        fields = read_base64_message(payload)
    except WireError:
        return None

    symbol = as_text(fields.get(_ID))
    price = as_float(fields.get(_PRICE))
    if not symbol or price is None:
        return None

    hours = fields.get(_MARKET_HOURS)
    # `sint64`, so it arrives zigzag-encoded and reads as twice its value.
    stamp = zigzag(fields.get(_TIME))

    return Tick(
        symbol=symbol,
        price=price,
        market_state=MARKET_HOURS.get(hours) if isinstance(hours, int) else None,
        change_percent=as_float(fields.get(_CHANGE_PERCENT)),
        # Yahoo stamps in milliseconds; everything else in this API is seconds.
        time=stamp / 1000 if stamp else None,
    )


def subscribe_frame(symbols: list[str]) -> str:
    return json.dumps({"subscribe": symbols})


class YahooStream:
    """
    One socket, resubscribed from scratch on every reconnect.

    Replaying a subscription after a drop is how a set of symbols silently
    drifts from what the connection actually carries. Sending the whole set is
    one frame and cannot drift.
    """

    def __init__(
        self,
        *,
        url: str = STREAM_URL,
        connect: Callable[..., object] | None = None,
        sleep: Callable[[float], object] | None = None,
    ) -> None:
        self._url = url
        # Injected so the reconnect loop can be tested without a network and
        # without waiting out a real backoff.
        self._connect = connect or websockets.connect
        self._sleep = sleep or asyncio.sleep
        self._symbols: set[str] = set()
        self._socket: object | None = None
        self._lock = asyncio.Lock()

    @property
    def symbols(self) -> set[str]:
        return set(self._symbols)

    async def watch(self, symbols: set[str]) -> None:
        """Replace the followed set, and tell the socket if one is open."""
        async with self._lock:
            if symbols == self._symbols:
                return
            self._symbols = set(symbols)
            socket = self._socket

        if socket is not None and symbols:
            with contextlib.suppress(Exception):
                await socket.send(subscribe_frame(sorted(symbols)))  # type: ignore[attr-defined]

    async def ticks(self) -> AsyncIterator[Tick]:
        """
        Ticks, forever, across reconnects.

        The caller never sees the drop: a failed connection becomes a pause,
        and the sweep is what covers the gap in the meantime.
        """
        backoff = _BACKOFF_START

        while True:
            try:
                async with self._connect(self._url) as socket:  # type: ignore[union-attr]
                    self._socket = socket
                    backoff = _BACKOFF_START

                    async with self._lock:
                        wanted = sorted(self._symbols)
                    if wanted:
                        await socket.send(subscribe_frame(wanted))

                    async for raw in socket:
                        tick = parse_tick(raw if isinstance(raw, str) else raw.decode())
                        if tick is not None:
                            yield tick
            except asyncio.CancelledError:
                raise
            except Exception as error:  # noqa: BLE001 — any failure is a reconnect
                logger.info("yahoo stream dropped, reconnecting in %.0fs: %s", backoff, error)
            finally:
                self._socket = None

            await self._sleep(backoff)
            backoff = min(backoff * _BACKOFF_FACTOR, _BACKOFF_MAX)
