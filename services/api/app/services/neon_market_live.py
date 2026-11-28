"""On-demand market data over transient, owner-scoped Postgres notifications."""

from __future__ import annotations

import asyncio
import base64
import binascii
import json
import logging
import os
import re
import time
from contextlib import AsyncExitStack
from typing import Any
from uuid import UUID

import httpx
import psycopg
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from psycopg import sql
from psycopg.conninfo import conninfo_to_dict, make_conninfo

from app.adapters.binance_bar_stream import BinanceBarStream
from app.adapters.binance_stream import BinanceStream
from app.adapters.live_bars import CompositeBarStream
from app.adapters.models import BarFocus
from app.adapters.registry import has_session
from app.adapters.streams import CompositeStream
from app.adapters.yahoo_buckets import session_at
from app.adapters.yahoo_live_bars import YahooLiveBarClient
from app.config import TIMEFRAMES
from app.services.market_worker import live_bar_wire, tick_wire

LOGGER = logging.getLogger(__name__)
SYMBOL = re.compile(r"[A-Z0-9.^=/_:-]{1,64}")
LEASE_SECONDS = 35
MAX_TABS = 16


def direct_connection(url: str) -> str:
    params = conninfo_to_dict(url)
    hostname = str(params["host"])
    host = hostname.split(".")
    if hostname.endswith(".neon.tech"):
        host[0] = host[0].removesuffix("-pooler")
    return make_conninfo(url, host=".".join(host), connect_timeout=8)


class MarketChannel:
    def __init__(self, owner: UUID, key: str):
        self.control = f"market_control_{owner.hex}"
        self.data = f"market_data_{owner.hex}"
        secret = base64.b64decode(key, validate=True)
        if len(secret) != 32:
            raise ValueError("MARKET_LIVE_KEY must contain 32 base64-encoded bytes")
        self.cipher = AESGCM(secret)

    def seal(self, channel: str, value: dict) -> str:
        nonce = os.urandom(12)
        raw = json.dumps(value, allow_nan=False, separators=(",", ":")).encode()
        return base64.b64encode(nonce + self.cipher.encrypt(nonce, raw, channel.encode())).decode()

    def open(self, channel: str, value: str) -> dict:
        raw = base64.b64decode(value, validate=True)
        result = json.loads(self.cipher.decrypt(raw[:12], raw[12:], channel.encode()))
        if not isinstance(result, dict):
            raise ValueError("invalid market message")
        return result


async def serve_market_live(database_url: str, channel: MarketChannel) -> None:
    """One socket per provider across visible tabs. Close feeds when the last lease expires."""
    async with AsyncExitStack() as stack:
        listen, send = [
            await stack.enter_async_context(
                await psycopg.AsyncConnection.connect(database_url, autocommit=True)
            )
            for _ in range(2)
        ]
        await listen.execute(sql.SQL("LISTEN {}").format(sql.Identifier(channel.control)))
        http = await stack.enter_async_context(httpx.AsyncClient(timeout=12, follow_redirects=True))
        bars = CompositeBarStream(BinanceBarStream(), YahooLiveBarClient(http))
        stack.push_async_callback(bars.close)
        leases: dict[str, tuple[float, set[str], BarFocus | None]] = {}
        prices: dict[str, dict] = {}
        candles: dict[BarFocus, dict] = {}
        ready: set[str] = set()
        changed = asyncio.Event()

        async def collect_prices(symbols: set[str]) -> None:
            stream = CompositeStream(pairs=BinanceStream(trades=True))
            await stream.watch(symbols)
            last: dict[str, tuple] = {}
            async for tick in stream.ticks():
                reading = (tick.price, tick.market_state, tick.extended)
                if reading != last.get(tick.symbol):
                    last[tick.symbol] = reading
                    prices[tick.symbol] = {
                        **tick_wire(tick),
                        "receivedAt": time.time_ns() // 1_000_000,
                    }
                    changed.set()

        async def collect_bars() -> None:
            async for update in bars.bars():
                candles[BarFocus(update.symbol, update.timeframe, update.extended)] = live_bar_wire(
                    update
                )
                changed.set()

        async def publish() -> None:
            while True:
                await changed.wait()
                started = time.monotonic()
                changed.clear()
                messages: list[tuple[str, list[Any]]] = [
                    ("ready", list(ready)),
                    ("ticks", list(prices.values())),
                    ("bars", list(candles.values())),
                ]
                prices.clear()
                candles.clear()
                ready.clear()
                packets = []
                for kind, rows in messages:
                    for i in range(0, len(rows), 8):
                        packet = channel.seal(channel.data, {kind: rows[i : i + 8]})
                        packets.append((channel.data, packet))
                async with send.cursor() as cursor:
                    await cursor.executemany("SELECT pg_notify(%s,%s)", packets)
                # An isolated update is sent immediately. Bursts collapse to the latest per symbol.
                await asyncio.sleep(max(0, 0.025 - (time.monotonic() - started)))

        async with asyncio.TaskGroup() as tasks:
            tasks.create_task(collect_bars())
            tasks.create_task(publish())
            quote_task = None
            watching: set[str] = set()
            while True:
                async for notice in listen.notifies(timeout=2, stop_after=1):
                    try:
                        msg = channel.open(channel.control, notice.payload)
                        client = str(UUID(msg["client"]))
                        if abs(time.time() - msg["at"]) > 20:
                            continue
                        symbols = msg["symbols"]
                        if (
                            not isinstance(symbols, list)
                            or len(symbols) > 64
                            or not all(isinstance(s, str) and SYMBOL.fullmatch(s) for s in symbols)
                        ):
                            continue
                        if not symbols:
                            leases.pop(client, None)
                        elif client in leases or len(leases) < MAX_TABS:
                            symbol, frame = msg.get("symbol"), msg.get("frame")
                            focus = None
                            if (
                                isinstance(symbol, str)
                                and symbol in symbols
                                and frame in TIMEFRAMES
                            ):
                                extended = (
                                    has_session(symbol) and session_at(time.time()) != "REGULAR"
                                )
                                focus = BarFocus(symbol, frame, extended)
                            leases[client] = (time.monotonic() + LEASE_SECONDS, set(symbols), focus)
                            ready.add(client)
                            changed.set()
                    except (ValueError, TypeError, KeyError, InvalidTag, binascii.Error):
                        continue
                now = time.monotonic()
                leases = {k: v for k, v in leases.items() if v[0] > now}
                wanted = set().union(*(v[1] for v in leases.values()))
                if wanted != watching:
                    if quote_task:
                        quote_task.cancel()
                        await asyncio.gather(quote_task, return_exceptions=True)
                    quote_task = tasks.create_task(collect_prices(wanted)) if wanted else None
                    watching = wanted
                await bars.watch({v[2] for v in leases.values() if v[2] is not None})


async def run_market_live(url: str, owner: UUID, key: str) -> None:
    try:
        channel = MarketChannel(owner, key)
        dsn = direct_connection(url)
    except (ValueError, psycopg.Error):
        LOGGER.error("market live disabled: invalid relay configuration")
        return
    while True:
        try:
            await serve_market_live(dsn, channel)
        except (psycopg.Error, OSError, ExceptionGroup) as error:
            LOGGER.warning("market live reconnecting (%s)", type(error).__name__)
            await asyncio.sleep(2)
