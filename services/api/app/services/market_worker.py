"""Pi owner of market streams, quote recovery, and disposable bar requests."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from app.adapters import registry
from app.adapters.models import Bar, ProviderError, Quote, SymbolHit, Tick
from app.adapters.streams import CompositeStream
from app.config import TIMEFRAMES, UPSTREAM_TIMEOUT_SECONDS
from app.services.collector_cloud import CollectorCloud, CollectorRequest

LOGGER = logging.getLogger(__name__)
QUOTE_FLUSH_SECONDS = 5.0
QUOTE_RECOVERY_SECONDS = 60.0
RECONCILE_SECONDS = 30.0
_DOCUMENT_KEYS = ("watchlist", "portfolio", "alert-rules")


@dataclass
class MarketRunStats:
    """Work durably observed by one worker process."""

    seen: int = 0
    written: int = 0
    failed: int = 0

    def records(self) -> dict[str, int]:
        return {"seen": self.seen, "written": self.written, "failed": self.failed}


def _symbol(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = registry.normalize_symbol(value)
    return normalized or None


def _entries(document: object, key: str) -> list[Mapping[str, object]]:
    if not isinstance(document, Mapping):
        return []
    items = document.get(key)
    return [item for item in items if isinstance(item, Mapping)] if isinstance(items, list) else []


def desired_symbols(documents: Mapping[str, object]) -> tuple[str, ...]:
    """Mirror the three browser document normalizers, failing closed on bad rows."""
    wanted: list[str] = []
    seen: set[str] = set()

    def add(value: object) -> None:
        symbol = _symbol(value)
        if symbol is not None and symbol not in seen:
            seen.add(symbol)
            wanted.append(symbol)

    for entry in _entries(documents.get("watchlist"), "entries"):
        add(entry.get("symbol"))
    for position in _entries(documents.get("portfolio"), "positions"):
        # Portfolio documents predate the valuation fields in some backups.
        # Quote ownership needs only the symbol; refusing an old row would
        # leave a legitimate holding permanently without a price.
        add(position.get("symbol"))
    alert_ids: set[str] = set()
    for alert in _entries(documents.get("alert-rules"), "alerts"):
        identifier, kind, price, active = (
            alert.get("id"),
            alert.get("kind"),
            alert.get("price"),
            alert.get("active"),
        )
        if (
            isinstance(identifier, str)
            and identifier
            and identifier not in alert_ids
            and kind in {"buy", "sell"}
            and isinstance(price, (int, float))
            and not isinstance(price, bool)
            and price > 0
        ):
            alert_ids.add(identifier)
            if active is True:
                add(alert.get("symbol"))
    return tuple(wanted)


def tick_wire(tick: Tick) -> dict[str, Any]:
    return {
        "symbol": tick.symbol,
        "price": tick.price,
        "marketState": tick.market_state,
        "extended": tick.extended,
        "changePercent": tick.change_percent,
        "time": tick.time,
    }


def quote_wire(quote: Quote) -> dict[str, Any]:
    return {
        "symbol": quote.symbol,
        "price": quote.price,
        "currency": quote.currency,
        "previousClose": quote.previous_close,
        "change": quote.change,
        "changePercent": quote.change_percent,
        "provider": quote.provider,
        "time": quote.time,
        "marketState": quote.market_state,
        "name": quote.name,
        "extended": quote.extended,
    }


def symbol_hit_wire(hit: SymbolHit) -> dict[str, str | None]:
    return {"symbol": hit.symbol, "name": hit.name, "kind": hit.kind, "exchange": hit.exchange}


def _market_time(value: float | None) -> int | None:
    """The wire keeps provider precision; the durable column is bigint seconds."""
    return int(value) if value is not None else None


class MarketWorker:
    def __init__(
        self,
        cloud: CollectorCloud,
        *,
        stream: CompositeStream | None = None,
        client: httpx.AsyncClient | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.cloud = cloud
        self.owner_id = cloud.owner_id
        self.stream = stream or CompositeStream()
        self.client = client or httpx.AsyncClient(
            timeout=UPSTREAM_TIMEOUT_SECONDS, follow_redirects=True
        )
        self._owns_client = client is None
        self._clock = clock
        self._pending: dict[str, Tick] = {}
        self._last_write: dict[str, float] = {}
        self._last_recovery = float("-inf")
        self._wake = asyncio.Event()
        self._run_stats = MarketRunStats()

    @property
    def run_records(self) -> dict[str, int]:
        return self._run_stats.records()

    def desired_symbols(self) -> tuple[str, ...]:
        return desired_symbols(self.cloud.documents(_DOCUMENT_KEYS))

    async def refresh_symbols(self) -> tuple[str, ...]:
        symbols = self.desired_symbols()
        await self.stream.watch(set(symbols))
        return symbols

    def accept(self, tick: Tick) -> None:
        self._pending[tick.symbol] = tick

    def flush_quotes(self) -> int:
        now = self._clock()
        rows: list[dict[str, Any]] = []
        for symbol, tick in tuple(self._pending.items()):
            if now - self._last_write.get(symbol, float("-inf")) < QUOTE_FLUSH_SECONDS:
                continue
            rows.append(self._tick_row(tick))
        if rows:
            # Do not throw away the latest ticks if Supabase is temporarily
            # unavailable: leaving them pending lets the next window retry.
            self._run_stats.seen += len(rows)
            try:
                self.cloud.merge_quote_ticks(rows)
            except Exception:
                self._run_stats.failed += len(rows)
                raise
            self._run_stats.written += len(rows)
            for row in rows:
                self._last_write[row["symbol"]] = now
                self._pending.pop(row["symbol"], None)
        return len(rows)

    async def recover_quotes(self) -> None:
        if self._clock() - self._last_recovery < QUOTE_RECOVERY_SECONDS:
            return
        self._last_recovery = self._clock()
        symbols = list(self.desired_symbols())
        if not symbols:
            return
        try:
            quotes, failures = await registry.fetch_quotes(self.client, symbols)
        except ProviderError as error:
            self._run_stats.seen += len(symbols)
            self._run_stats.failed += len(symbols)
            LOGGER.warning("market quote recovery failed: %s", error.code)
            return
        self._run_stats.seen += len(quotes) + len(failures)
        if failures:
            self._run_stats.failed += len(failures)
            LOGGER.warning("market quote recovery had %d failed symbols", len(failures))
        if quotes:
            try:
                self.cloud.upsert_quotes([self._quote_row(quote) for quote in quotes])
            except Exception:
                self._run_stats.failed += len(quotes)
                raise
            self._run_stats.written += len(quotes)

    async def serve_request(self, request: CollectorRequest) -> None:
        """Terminally settle a claimed request once, with no provider text leaked."""
        self._run_stats.seen += 1
        if request.operation == "market-bars":
            try:
                row, result = await self._bars(request.payload)
                self.cloud.upsert_bars(row)
            except ProviderError as error:
                self._run_stats.failed += 1
                self._fail(request, error.code)
                return
            except (TypeError, ValueError):
                self._run_stats.failed += 1
                self._fail(request, "invalid-request")
                return
            except Exception:  # noqa: BLE001 - terminal cloud/provider boundary is sanitized
                self._run_stats.failed += 1
                self._fail(request, "market-unavailable")
                return
            self._complete(request, result)
            self._run_stats.written += 1
            return
        if request.operation == "market-search":
            try:
                result = await self._search(request.payload)
            except ProviderError as error:
                self._run_stats.failed += 1
                self._fail(request, error.code)
                return
            except (TypeError, ValueError):
                self._run_stats.failed += 1
                self._fail(request, "invalid-request")
                return
            except Exception:  # noqa: BLE001 - terminal cloud/provider boundary is sanitized
                self._run_stats.failed += 1
                self._fail(request, "market-unavailable")
                return
            self._complete(request, result)
            self._run_stats.written += 1
            return
        self._run_stats.failed += 1
        self._fail(request, "invalid-request")

    async def claim_until_empty(self) -> int:
        claimed = 0
        while (request := self.cloud.claim_request(("market-bars", "market-search"))) is not None:
            claimed += 1
            await self.serve_request(request)
        return claimed

    async def run(
        self,
        stop_event: asyncio.Event,
        cycle_completed: Callable[[Mapping[str, int]], None] | None = None,
    ) -> None:
        """Run stream/recovery work; callers may set wake on a Realtime insert."""
        if stop_event.is_set():
            return
        ticks = asyncio.create_task(self._consume_ticks(stop_event))
        try:
            while not stop_event.is_set():
                healthy = await self.reconcile_once()
                if healthy and cycle_completed is not None:
                    cycle_completed(self.run_records)
                await self._wait_for_wake_or_stop(stop_event)
        finally:
            ticks.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await ticks
            self.flush_quotes()
            if self._owns_client:
                await self.client.aclose()

    async def reconcile_once(self) -> bool:
        """Complete one bounded document, request, and quote reconciliation."""
        failures_before = self._run_stats.failed
        await self.refresh_symbols()
        await self.claim_until_empty()
        await self.recover_quotes()
        self.flush_quotes()
        return self._run_stats.failed == failures_before

    def wake_requests(self) -> None:
        self._wake.set()

    async def _consume_ticks(self, stop_event: asyncio.Event) -> None:
        async for tick in self.stream.ticks():
            if stop_event.is_set():
                return
            self.accept(tick)

    async def _wait_for_wake_or_stop(self, stop_event: asyncio.Event) -> None:
        wake = asyncio.create_task(self._wake.wait())
        stopped = asyncio.create_task(stop_event.wait())
        try:
            done, _ = await asyncio.wait(
                {wake, stopped}, timeout=RECONCILE_SECONDS, return_when=asyncio.FIRST_COMPLETED
            )
            if wake in done:
                self._wake.clear()
        finally:
            for task in (wake, stopped):
                if not task.done():
                    task.cancel()
            await asyncio.gather(wake, stopped, return_exceptions=True)

    def _tick_row(self, tick: Tick) -> dict[str, Any]:
        return {
            "owner_id": str(self.owner_id),
            "symbol": tick.symbol,
            "provider": tick.provider,
            "market_time": _market_time(tick.time),
            "fetched_at": datetime.now(UTC).isoformat(),
            "payload": tick_wire(tick),
        }

    def _quote_row(self, quote: Quote) -> dict[str, Any]:
        return {
            "owner_id": str(self.owner_id),
            "symbol": quote.symbol,
            "provider": quote.provider,
            "market_time": _market_time(quote.time),
            "fetched_at": datetime.now(UTC).isoformat(),
            "payload": quote_wire(quote),
        }

    async def _bars(self, payload: Mapping[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
        symbol = _symbol(payload.get("symbol"))
        timeframe = payload.get("timeframe")
        extended = payload.get("extended", False)
        if symbol is None or not isinstance(timeframe, str) or timeframe not in TIMEFRAMES:
            raise ValueError("invalid bars request")
        if not isinstance(extended, bool):
            raise ValueError("invalid bars request")
        bars = await registry.fetch_bars(
            self.client, symbol, TIMEFRAMES[timeframe], extended=extended
        )
        response = {
            "symbol": symbol,
            "timeframe": timeframe,
            "provider": registry.provider_for(symbol),
            "extended": extended,
            "hasSession": registry.has_session(symbol),
            "stale": False,
            "bars": [self._bar_wire(bar) for bar in bars],
        }
        now = datetime.now(UTC)
        row = {
            "owner_id": str(self.owner_id),
            "symbol": symbol,
            "timeframe": timeframe,
            "extended": extended,
            "provider": registry.provider_for(symbol),
            "fetched_at": now.isoformat(),
            "expires_at": (now + timedelta(seconds=TIMEFRAMES[timeframe].ttl)).isoformat(),
            "payload": response,
        }
        return row, response

    async def _search(self, payload: Mapping[str, Any]) -> dict[str, Any]:
        query = payload.get("query")
        if not isinstance(query, str) or not query.strip():
            raise ValueError("invalid search request")
        hits = await registry.search(self.client, query.strip(), limit=10)
        return {"results": [symbol_hit_wire(hit) for hit in hits]}

    @staticmethod
    def _bar_wire(bar: Bar) -> dict[str, float | int]:
        return {
            "time": bar.time,
            "open": bar.open,
            "high": bar.high,
            "low": bar.low,
            "close": bar.close,
            "volume": bar.volume,
        }

    def _fail(self, request: CollectorRequest, code: str) -> None:
        safe = code if code and len(code) <= 64 else "market-unavailable"
        try:
            self.cloud.fail_request(request.id, safe)
        except Exception:  # noqa: BLE001 - a terminal write may already have won
            LOGGER.warning("market worker could not record request failure")

    def _complete(self, request: CollectorRequest, result: Mapping[str, Any]) -> None:
        try:
            self.cloud.complete_request(request.id, result)
        except Exception:  # noqa: BLE001 - do not race a possibly committed completion with fail
            LOGGER.warning("market worker could not confirm request completion")
