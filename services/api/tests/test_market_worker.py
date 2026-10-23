"""The Pi market worker owns provider acquisition, never browser requests."""

from __future__ import annotations

import asyncio
import contextlib
import threading
import time
from datetime import UTC, datetime
from unittest.mock import AsyncMock, Mock
from uuid import UUID

import pytest

from app.adapters import registry
from app.adapters.models import Bar, BarFocus, LiveBar, Quote, Tick
from app.services import market_worker
from app.services.chart_focus import ChartFocusBook
from app.services.collector_cloud import CollectorCloudUnavailable, CollectorRequest
from app.services.market_worker import MarketWorker

OWNER = UUID("11111111-1111-1111-1111-111111111111")


def quote(price: float) -> Quote:
    return Quote("AAPL", price, "USD", 100, "yahoo", time=10)


class Clock:
    def __init__(self) -> None:
        self.value = 0.0

    def __call__(self) -> float:
        return self.value

    def advance(self, seconds: float) -> None:
        self.value += seconds


class IdleStream:
    async def watch(self, _symbols):
        return None

    async def ticks(self):
        await asyncio.Event().wait()
        yield  # pragma: no cover - establishes this as an async generator


class IdleBarStream:
    def __init__(self) -> None:
        self.watched: list[set[BarFocus]] = []
        self.started = asyncio.Event()
        self.changed = asyncio.Event()
        self.cancelled = asyncio.Event()

    async def watch(self, focuses: set[BarFocus]) -> None:
        self.watched.append(set(focuses))
        self.changed.set()

    async def bars(self):
        self.started.set()
        try:
            await asyncio.Event().wait()
        finally:
            self.cancelled.set()
        yield  # pragma: no cover - establishes this as an async generator


class FailingBarStream:
    async def watch(self, _focuses: set[BarFocus]) -> None:
        return None

    async def bars(self):
        raise RuntimeError("bar stream failed")
        yield  # pragma: no cover - establishes this as an async generator


def live_bar(
    *, close: float = 100, volume: float = 10, as_of: float = 1, symbol: str = "AAPL"
) -> LiveBar:
    return LiveBar(
        symbol=symbol,
        timeframe="15m",
        extended=False,
        as_of=as_of,
        bar=Bar(time=100, open=99, high=max(100, close), low=98, close=close, volume=volume),
        provider="yahoo",
    )


def focus_payload(
    *, client_id: str = "tab-a", symbol: str = "AAPL", active: bool = True
) -> dict[str, object]:
    return {
        "clientId": client_id,
        "symbol": symbol,
        "timeframe": "15m",
        "extended": False,
        "active": active,
    }


def cloud() -> Mock:
    result = Mock()
    result.owner_id = OWNER
    result.list_cached_bars.return_value = []
    result.documents.return_value = {
        "watchlist": {"entries": [{"symbol": " AAPL "}, {"symbol": {}}]},
        "portfolio": {
            "positions": [
                {"symbol": "BTC-USD", "quantity": 1, "averageCost": 1},
                {"symbol": "bad", "quantity": 0, "averageCost": 1},
            ]
        },
        "alert-rules": {
            "alerts": [
                {
                    "id": "same",
                    "symbol": "aapl",
                    "kind": "buy",
                    "price": 1,
                    "active": True,
                    "createdAt": 0,
                    "triggeredAt": None,
                },
                {"id": "ignored", "symbol": "MSFT", "active": False},
            ]
        },
    }
    return result


def expect_tick(symbol: str, price: float, *, time: float | None) -> dict[str, object]:
    return {
        "symbol": symbol,
        "price": price,
        "marketState": None,
        "extended": False,
        "changePercent": None,
        "time": time,
    }


def test_symbols_union_three_documents_without_duplicates():
    """Removing source validation would poll malformed or duplicate symbols."""
    assert MarketWorker(cloud()).desired_symbols() == ("AAPL", "BTC-USD", "BAD")


def test_partial_portfolio_position_still_owns_its_symbol():
    """Legacy valuation fields must not silently stop quote ownership."""
    remote = cloud()
    remote.documents.return_value["portfolio"] = {"positions": [{"symbol": "  msft  "}]}

    assert MarketWorker(remote).desired_symbols() == ("AAPL", "MSFT")


def test_slow_cloud_claim_does_not_block_event_loop():
    async def scenario():
        remote = cloud()

        def slow_claim(_operations):
            time.sleep(0.15)
            return None

        remote.claim_request.side_effect = slow_claim
        worker = MarketWorker(remote, stream=IdleStream(), bar_stream=IdleBarStream())
        task = asyncio.create_task(worker.claim_until_empty())
        await asyncio.wait_for(asyncio.sleep(0.01), timeout=0.1)
        assert not task.done()
        await task

    asyncio.run(scenario())


def test_duplicate_queued_bars_reuse_one_fresh_provider_result(monkeypatch):
    async def scenario():
        remote = cloud()
        clock = Clock()
        worker = MarketWorker(remote, clock=clock, client=Mock())
        fetched = AsyncMock(return_value=[Bar(1, 1, 2, 1, 2, 3)])
        monkeypatch.setattr(registry, "fetch_bars", fetched)
        payload = {"symbol": "AAPL", "timeframe": "1m", "extended": False}

        first = await worker._bars(payload)
        second = await worker._bars(payload)
        assert first == second
        fetched.assert_awaited_once()

        clock.advance(11)
        await worker._bars(payload)
        assert fetched.await_count == 2

    asyncio.run(scenario())


def test_reconciliation_updates_a_watched_daily_candle_without_a_browser_request(monkeypatch):
    """A closed Investing tab must not stop the Pi from warming its chart cache."""

    async def scenario():
        remote = cloud()
        remote.documents.return_value = {"watchlist": {"entries": [{"symbol": "AAPL"}]}}
        remote.claim_request.return_value = None
        worker = MarketWorker(
            remote, stream=IdleStream(), bar_stream=IdleBarStream(), client=Mock()
        )
        worker.recover_quotes = AsyncMock()
        fetched = AsyncMock(return_value=[Bar(100, 99, 101, 98, 100, 10)])
        monkeypatch.setattr(registry, "fetch_bars", fetched)

        await worker.reconcile_once()

        fetched.assert_awaited_once()
        assert fetched.await_args.args[1] == "AAPL"
        assert fetched.await_args.args[2].key == "1d"
        row = remote.upsert_bars.call_args.args[0]
        assert row["symbol"] == "AAPL"
        assert row["timeframe"] == "1d"
        assert row["payload"]["bars"] == [
            {"time": 100, "open": 99, "high": 101, "low": 98, "close": 100, "volume": 10}
        ]
        remote.claim_request.assert_called_once_with(("market-bars", "market-search"))

    asyncio.run(scenario())


def test_reconciliation_refreshes_an_expired_viewed_timeframe_without_a_browser(monkeypatch):
    """A previously viewed 15m series stays current after the tab is closed."""

    async def scenario():
        remote = cloud()
        remote.documents.return_value = {"watchlist": {"entries": [{"symbol": "AAPL"}]}}
        remote.claim_request.return_value = None
        remote.list_cached_bars.return_value = [
            {
                "symbol": "AAPL",
                "timeframe": "1d",
                "extended": False,
                "expires_at": "2099-10-23T10:05:00+00:00",
            },
            {
                "symbol": "AAPL",
                "timeframe": "1d",
                "extended": True,
                "expires_at": "2099-10-23T10:05:00+00:00",
            },
            {
                "symbol": "AAPL",
                "timeframe": "15m",
                "extended": True,
                "expires_at": "2020-10-23T10:00:30+00:00",
            },
        ]
        worker = MarketWorker(
            remote, stream=IdleStream(), bar_stream=IdleBarStream(), client=Mock()
        )
        worker.recover_quotes = AsyncMock()
        fetched = AsyncMock(return_value=[Bar(100, 99, 101, 98, 100, 10)])
        monkeypatch.setattr(registry, "fetch_bars", fetched)

        await worker.reconcile_once()

        fetched.assert_awaited_once()
        assert fetched.await_args.args[1] == "AAPL"
        assert fetched.await_args.args[2].key == "15m"
        assert fetched.await_args.kwargs == {"extended": True}
        assert remote.upsert_bars.call_args.args[0]["extended"] is True

    asyncio.run(scenario())


def test_new_watched_daily_chart_is_not_starved_by_an_expiring_one_minute_chart(monkeypatch):
    async def scenario():
        remote = cloud()
        remote.documents.return_value = {
            "watchlist": {"entries": [{"symbol": "AAPL"}, {"symbol": "QQQ"}]}
        }
        remote.claim_request.return_value = None
        remote.list_cached_bars.return_value = [
            {
                "symbol": "AAPL",
                "timeframe": "1d",
                "extended": extended,
                "expires_at": "2099-10-23T10:05:00+00:00",
            }
            for extended in (False, True)
        ] + [
            {
                "symbol": "AAPL",
                "timeframe": "1m",
                "extended": False,
                "expires_at": "2020-10-23T10:00:00+00:00",
            }
        ]
        worker = MarketWorker(
            remote, stream=IdleStream(), bar_stream=IdleBarStream(), client=Mock()
        )
        worker.recover_quotes = AsyncMock()
        fetched = AsyncMock(return_value=[Bar(100, 99, 101, 98, 100, 10)])
        monkeypatch.setattr(registry, "fetch_bars", fetched)

        await worker.reconcile_once()

        assert fetched.await_args.args[1] == "QQQ"
        assert fetched.await_args.args[2].key == "1d"

    asyncio.run(scenario())


def test_expired_watched_daily_chart_precedes_older_intraday_cache(monkeypatch):
    async def scenario():
        remote = cloud()
        remote.documents.return_value = {
            "watchlist": {"entries": [{"symbol": "AAPL"}, {"symbol": "QQQ"}]}
        }
        remote.claim_request.return_value = None
        remote.list_cached_bars.return_value = [
            {
                "symbol": symbol,
                "timeframe": "1d",
                "extended": extended,
                "expires_at": "2099-10-23T10:05:00+00:00",
            }
            for symbol in ("AAPL", "QQQ")
            for extended in (False, True)
            if (symbol, extended) != ("QQQ", True)
        ] + [
            {
                "symbol": "QQQ",
                "timeframe": "1d",
                "extended": True,
                "expires_at": "2023-10-23T10:00:00+00:00",
            },
            {
                "symbol": "AAPL",
                "timeframe": "1m",
                "extended": False,
                "expires_at": "2020-10-23T10:00:00+00:00",
            },
        ]
        worker = MarketWorker(
            remote, stream=IdleStream(), bar_stream=IdleBarStream(), client=Mock()
        )
        worker.recover_quotes = AsyncMock()
        fetched = AsyncMock(return_value=[Bar(100, 99, 101, 98, 100, 10)])
        monkeypatch.setattr(registry, "fetch_bars", fetched)

        await worker.reconcile_once()

        assert fetched.await_args.args[1] == "QQQ"
        assert fetched.await_args.args[2].key == "1d"
        assert fetched.await_args.kwargs == {"extended": True}

    asyncio.run(scenario())


def test_background_candles_rest_after_the_final_stock_session(monkeypatch):
    """Expired TTLs alone must not hammer Yahoo all night or over a weekend."""

    async def scenario():
        remote = cloud()
        remote.documents.return_value = {"watchlist": {"entries": [{"symbol": "AAPL"}]}}
        remote.claim_request.return_value = None
        remote.list_cached_bars.return_value = [
            {
                "symbol": "AAPL",
                "timeframe": "1d",
                "extended": extended,
                "fetched_at": "2026-10-24T00:05:00+00:00",
                "expires_at": "2026-10-24T00:10:00+00:00",
            }
            for extended in (False, True)
        ]
        worker = MarketWorker(
            remote,
            stream=IdleStream(),
            bar_stream=IdleBarStream(),
            client=Mock(),
            wall_clock=lambda: datetime(2026, 10, 24, 1, tzinfo=UTC),
        )
        worker.recover_quotes = AsyncMock()
        fetched = AsyncMock(return_value=[Bar(100, 99, 101, 98, 100, 10)])
        monkeypatch.setattr(registry, "fetch_bars", fetched)

        await worker.reconcile_once()

        fetched.assert_not_awaited()
        remote.upsert_bars.assert_not_called()

    asyncio.run(scenario())


def test_provider_closed_state_prevents_repeated_holiday_bar_fetches(monkeypatch):
    async def scenario():
        remote = cloud()
        remote.documents.return_value = {"watchlist": {"entries": [{"symbol": "AAPL"}]}}
        remote.claim_request.return_value = None
        remote.list_cached_bars.return_value = [
            {
                "symbol": "AAPL",
                "timeframe": "1d",
                "extended": extended,
                "fetched_at": "2026-10-23T00:05:00+00:00",
                "expires_at": "2026-10-23T00:10:00+00:00",
            }
            for extended in (False, True)
        ]
        worker = MarketWorker(
            remote,
            stream=IdleStream(),
            bar_stream=IdleBarStream(),
            client=Mock(),
            wall_clock=lambda: datetime(2026, 10, 23, 15, tzinfo=UTC),
        )
        worker.recover_quotes = AsyncMock()
        worker.accept(Tick("AAPL", 100, "yahoo", market_state="CLOSED", time=1))
        fetched = AsyncMock(return_value=[Bar(100, 99, 101, 98, 100, 10)])
        monkeypatch.setattr(registry, "fetch_bars", fetched)

        await worker.reconcile_once()

        fetched.assert_not_awaited()

    asyncio.run(scenario())


def test_default_aapl_chart_uses_provider_closed_state_without_watchlist(monkeypatch):
    async def scenario():
        remote = cloud()
        remote.documents.return_value = {}
        remote.claim_request.return_value = None
        remote.list_cached_bars.return_value = [
            {
                "symbol": "AAPL",
                "timeframe": "1d",
                "extended": extended,
                "fetched_at": "2026-10-23T00:05:00+00:00",
                "expires_at": "2026-10-23T00:10:00+00:00",
            }
            for extended in (False, True)
        ]
        worker = MarketWorker(
            remote,
            stream=IdleStream(),
            bar_stream=IdleBarStream(),
            client=Mock(),
            wall_clock=lambda: datetime(2026, 10, 23, 15, tzinfo=UTC),
        )
        quotes = AsyncMock(
            return_value=([Quote("AAPL", 100, "USD", 99, "yahoo", market_state="CLOSED")], [])
        )
        bars = AsyncMock(return_value=[Bar(100, 99, 101, 98, 100, 10)])
        monkeypatch.setattr(registry, "fetch_quotes", quotes)
        monkeypatch.setattr(registry, "fetch_bars", bars)

        await worker.reconcile_once()

        quotes.assert_awaited_once()
        assert quotes.await_args.args[1] == ["AAPL"]
        bars.assert_not_awaited()

    asyncio.run(scenario())


def test_background_refresh_respects_a_slower_daily_cadence(monkeypatch):
    async def scenario():
        remote = cloud()
        remote.list_cached_bars.return_value = [
            {
                "symbol": "AAPL",
                "timeframe": "1d",
                "extended": extended,
                "fetched_at": "2026-10-23T14:30:00+00:00",
                "expires_at": "2026-10-23T14:35:00+00:00",
            }
            for extended in (False, True)
        ]
        worker = MarketWorker(
            remote, client=Mock(), wall_clock=lambda: datetime(2026, 10, 23, 15, tzinfo=UTC)
        )
        bars = AsyncMock(return_value=[Bar(100, 99, 101, 98, 100, 10)])
        monkeypatch.setattr(registry, "fetch_bars", bars)

        await worker.refresh_cached_bars()
        bars.assert_not_awaited()

        remote.list_cached_bars.return_value[0]["fetched_at"] = "2026-10-23T10:30:00+00:00"
        await worker.refresh_cached_bars()
        bars.assert_awaited_once()

    asyncio.run(scenario())


def test_background_refresh_has_a_daily_provider_budget(monkeypatch):
    async def scenario():
        monkeypatch.setattr(market_worker, "BACKGROUND_DAILY_BAR_LIMIT", 1)
        remote = cloud()
        worker = MarketWorker(remote, client=Mock())
        bars = AsyncMock(return_value=[Bar(100, 99, 101, 98, 100, 10)])
        monkeypatch.setattr(registry, "fetch_bars", bars)

        await worker.refresh_cached_bars()
        await worker.refresh_cached_bars()

        bars.assert_awaited_once()

    asyncio.run(scenario())


def test_background_bar_metadata_outage_does_not_stop_quote_reconciliation():
    async def scenario():
        remote = cloud()
        remote.documents.return_value = {}
        remote.claim_request.return_value = None
        remote.list_cached_bars.side_effect = CollectorCloudUnavailable("offline")
        worker = MarketWorker(
            remote, stream=IdleStream(), bar_stream=IdleBarStream(), client=Mock()
        )
        worker.recover_quotes = AsyncMock()
        worker.flush_quotes_async = AsyncMock()

        assert await worker.reconcile_once() is False
        worker.flush_quotes_async.assert_awaited_once()

    asyncio.run(scenario())


def test_many_ticks_flush_one_latest_quote_per_window():
    """Writing each tick would turn a busy symbol into five-second-row churn."""
    remote = cloud()
    clock = Clock()
    worker = MarketWorker(remote, clock=clock)
    worker.accept(Tick("AAPL", 100, "yahoo", time=1))
    worker.accept(Tick("AAPL", 101, "yahoo", time=2))
    clock.advance(5)

    worker.flush_quotes()

    remote.merge_quote_ticks.assert_called_once()
    row = remote.merge_quote_ticks.call_args.args[0][0]
    assert row["symbol"] == "AAPL"
    assert row["payload"]["price"] == 101
    assert worker.run_records == {"seen": 1, "written": 1, "failed": 0}


def test_live_batch_keeps_only_the_newest_tick_per_symbol():
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    worker.accept(Tick("AAPL", 100, "yahoo", time=1))
    worker.accept(Tick("AAPL", 101, "yahoo", time=2))

    assert asyncio.run(worker.publish_ticks()) == 1
    remote.broadcast_quote_ticks.assert_called_once_with([expect_tick("AAPL", 101, time=2)])


def test_live_batch_omits_a_burst_that_returns_to_the_last_visible_reading():
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    worker.accept(Tick("AAPL", 100, "yahoo", market_state="REGULAR", time=1))
    asyncio.run(worker.publish_ticks())
    remote.broadcast_quote_ticks.reset_mock()
    worker.accept(Tick("AAPL", 101, "yahoo", market_state="REGULAR", time=2))
    worker.accept(Tick("AAPL", 100, "yahoo", market_state="REGULAR", time=3))

    assert asyncio.run(worker.publish_ticks()) == 0
    remote.broadcast_quote_ticks.assert_not_called()


def test_failed_broadcast_retries_only_the_newest_pending_tick():
    remote = cloud()
    remote.broadcast_quote_ticks.side_effect = [
        CollectorCloudUnavailable("offline"),
        1,
    ]
    worker = MarketWorker(remote, clock=Clock())
    worker.accept(Tick("AAPL", 100, "yahoo", time=1))
    assert asyncio.run(worker.publish_ticks()) == 0
    worker.accept(Tick("AAPL", 102, "yahoo", time=2))

    assert asyncio.run(worker.publish_ticks()) == 1
    assert remote.broadcast_quote_ticks.call_args.args[0][0]["price"] == 102


def test_volume_only_change_is_a_visible_bar_update():
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    worker.accept_bar(live_bar(close=100, volume=10, as_of=1))

    assert asyncio.run(worker.publish_bars()) == 1


def test_newer_as_of_without_an_ohlcv_change_is_not_rebroadcast():
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    worker.accept_bar(live_bar(close=100, volume=10, as_of=1))
    assert asyncio.run(worker.publish_bars()) == 1

    worker.accept_bar(live_bar(close=100, volume=10, as_of=2))
    assert asyncio.run(worker.publish_bars()) == 0
    assert worker._live_bar_pending == {}

    worker.accept_bar(live_bar(close=100, volume=12, as_of=2))
    assert asyncio.run(worker.publish_bars()) == 1


def test_older_bar_snapshot_does_not_replace_a_newer_pending_snapshot():
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    worker.accept_bar(live_bar(close=102, volume=12, as_of=2))
    worker.accept_bar(live_bar(close=101, volume=11, as_of=1))

    assert asyncio.run(worker.publish_bars()) == 1
    assert remote.broadcast_live_bars.call_args.args[0][0]["bar"]["close"] == 102


def test_failed_bar_broadcast_retries_only_newest_snapshot():
    remote = cloud()
    remote.broadcast_live_bars.side_effect = [CollectorCloudUnavailable("offline"), 1]
    worker = MarketWorker(remote, clock=Clock())
    worker.accept_bar(live_bar(close=100, volume=10, as_of=1))
    assert asyncio.run(worker.publish_bars()) == 0

    worker.accept_bar(live_bar(close=101, volume=12, as_of=2))
    assert asyncio.run(worker.publish_bars()) == 1
    assert remote.broadcast_live_bars.call_args.args[0][0]["bar"]["close"] == 101


def test_bar_publication_failure_does_not_stop_quote_publication():
    async def scenario():
        remote = cloud()
        remote.broadcast_live_bars.side_effect = CollectorCloudUnavailable("offline")
        worker = MarketWorker(remote, clock=Clock())
        worker.accept_bar(live_bar())
        worker.accept(Tick("AAPL", 101, "yahoo", time=2))

        assert await asyncio.gather(worker.publish_bars(), worker.publish_ticks()) == [0, 1]
        remote.broadcast_quote_ticks.assert_called_once()

    asyncio.run(scenario())


def test_focus_heartbeat_immediately_updates_bar_stream_watch():
    async def scenario():
        remote = cloud()
        bar_stream = IdleBarStream()
        worker = MarketWorker(
            remote,
            stream=IdleStream(),
            bar_stream=bar_stream,
            focus_book=ChartFocusBook(ttl_seconds=45, max_clients=8),
            client=Mock(),
        )
        worker.reconcile_once = AsyncMock(return_value=True)
        stopped = asyncio.Event()
        task = asyncio.create_task(worker.run(stopped))
        await asyncio.wait_for(bar_stream.changed.wait(), 0.1)
        bar_stream.changed.clear()

        assert worker.accept_focus(focus_payload())
        await asyncio.wait_for(bar_stream.changed.wait(), 0.1)
        assert bar_stream.watched[-1] == {BarFocus("AAPL", "15m", False)}

        stopped.set()
        await asyncio.wait_for(task, 0.1)

    asyncio.run(scenario())


def test_focus_lease_expiry_removes_focus_without_another_browser_message():
    async def scenario():
        remote = cloud()
        bar_stream = IdleBarStream()
        worker = MarketWorker(
            remote,
            stream=IdleStream(),
            bar_stream=bar_stream,
            focus_book=ChartFocusBook(ttl_seconds=0.1, max_clients=8),
            client=Mock(),
        )
        worker.reconcile_once = AsyncMock(return_value=True)
        stopped = asyncio.Event()
        task = asyncio.create_task(worker.run(stopped))
        await asyncio.wait_for(bar_stream.changed.wait(), 0.1)
        bar_stream.changed.clear()

        assert worker.accept_focus(focus_payload())
        await asyncio.wait_for(bar_stream.changed.wait(), 0.1)
        bar_stream.changed.clear()
        for _ in range(50):
            if bar_stream.watched[-1] == set():
                break
            await asyncio.sleep(0.01)
        assert bar_stream.watched[-1] == set()

        stopped.set()
        await asyncio.wait_for(task, 0.1)

    asyncio.run(scenario())


def test_shutdown_cancels_bar_consumer_promptly():
    async def scenario():
        remote = cloud()
        bar_stream = IdleBarStream()
        worker = MarketWorker(
            remote,
            stream=IdleStream(),
            bar_stream=bar_stream,
            client=Mock(),
        )
        worker.reconcile_once = AsyncMock(return_value=True)
        stopped = asyncio.Event()
        task = asyncio.create_task(worker.run(stopped))
        await asyncio.wait_for(bar_stream.started.wait(), 0.1)

        stopped.set()
        await asyncio.wait_for(task, 0.1)
        assert bar_stream.cancelled.is_set()

    asyncio.run(scenario())


def test_background_bar_failure_is_reraised_without_waiting_for_reconciliation():
    async def scenario():
        remote = cloud()
        worker = MarketWorker(remote, bar_stream=FailingBarStream(), client=Mock())
        worker.reconcile_once = AsyncMock(return_value=True)

        with pytest.raises(RuntimeError, match="bar stream failed"):
            await asyncio.wait_for(worker.run(asyncio.Event()), 0.1)

    asyncio.run(scenario())


def test_database_tick_snapshots_remain_bounded_to_sixty_seconds():
    remote = cloud()
    clock = Clock()
    worker = MarketWorker(remote, clock=clock)
    worker.accept(Tick("AAPL", 100, "yahoo", time=1))
    worker.flush_quotes()
    clock.advance(59)
    worker.accept(Tick("AAPL", 101, "yahoo", time=2))
    worker.flush_quotes()
    assert remote.merge_quote_ticks.call_count == 1

    clock.advance(1)
    worker.flush_quotes()
    assert remote.merge_quote_ticks.call_count == 2
    assert remote.merge_quote_ticks.call_args.args[0][0]["payload"]["price"] == 101


def test_tick_market_time_is_an_integer_for_the_database_column():
    """Passing Binance's fractional seconds to bigint would reject an otherwise good quote."""
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    worker.accept(Tick("AAPL", 101, "yahoo", time=2.25))

    worker.flush_quotes()

    assert remote.merge_quote_ticks.call_args.args[0][0]["market_time"] == 2


def test_failed_quote_flush_keeps_the_latest_tick_for_a_later_retry():
    """Dropping a tick before a rejected upsert makes a quiet market permanently stale."""
    remote = cloud()
    remote.merge_quote_ticks.side_effect = [RuntimeError("offline"), None]
    clock = Clock()
    worker = MarketWorker(remote, clock=clock)
    worker.accept(Tick("AAPL", 100, "yahoo", time=1))

    with contextlib.suppress(RuntimeError):
        worker.flush_quotes()
    worker.accept(Tick("AAPL", 101, "yahoo", time=2))
    worker.flush_quotes()

    assert remote.merge_quote_ticks.call_count == 2
    assert remote.merge_quote_ticks.call_args.args[0][0]["payload"]["price"] == 101
    assert worker.run_records == {"seen": 2, "written": 1, "failed": 1}


def test_request_completion_and_failure_are_counted_in_the_service_run():
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    request = CollectorRequest(
        UUID("22222222-2222-2222-2222-222222222222"),
        OWNER,
        "market-search",
        {"query": "apple"},
        datetime.now(UTC),
    )
    worker._search = AsyncMock(return_value={"results": []})

    asyncio.run(worker.serve_request(request))
    worker._search = AsyncMock(side_effect=ValueError("bad request"))
    asyncio.run(worker.serve_request(request))

    assert worker.run_records == {"seen": 2, "written": 1, "failed": 1}
    remote.complete_request.assert_called_once_with(request.id, {"results": []})
    remote.fail_request.assert_called_once_with(request.id, "invalid-request")


def test_market_claim_loop_requests_only_market_operations():
    remote = cloud()
    remote.claim_request.return_value = None

    assert asyncio.run(MarketWorker(remote, clock=Clock()).claim_until_empty()) == 0

    remote.claim_request.assert_called_once_with(("market-bars", "market-search"))


def test_quote_recovery_counts_returned_provider_failures(monkeypatch):
    remote = cloud()
    remote.documents.return_value = {
        "watchlist": {"entries": [{"symbol": "AAPL"}, {"symbol": "BAD"}]}
    }
    worker = MarketWorker(remote, clock=Clock())

    async def fetch_quotes(_client, _symbols):
        return [quote(101)], [("BAD", RuntimeError("private detail"))]

    monkeypatch.setattr(registry, "fetch_quotes", fetch_quotes)

    before = worker.run_records["failed"]
    asyncio.run(worker.recover_quotes())

    assert worker.run_records == {"seen": 2, "written": 1, "failed": 1}
    assert worker.run_records["failed"] > before
    remote.upsert_quotes.assert_called_once()


def test_publisher_runs_without_another_reconciliation(monkeypatch):
    monkeypatch.setattr(market_worker, "LIVE_BROADCAST_SECONDS", 0.01)

    async def scenario():
        remote = cloud()
        stopped = asyncio.Event()
        loop = asyncio.get_running_loop()
        remote.broadcast_quote_ticks.side_effect = lambda _rows: (
            loop.call_soon_threadsafe(stopped.set) or 1
        )
        worker = MarketWorker(remote, stream=IdleStream(), client=Mock())
        worker.reconcile_once = AsyncMock(return_value=True)
        worker.accept(Tick("AAPL", 101, "yahoo", time=2))

        await asyncio.wait_for(worker.run(stopped), 0.2)

        assert worker.reconcile_once.await_count == 1
        remote.broadcast_quote_ticks.assert_called_once()

    asyncio.run(scenario())


def test_slow_broadcasts_do_not_overlap_or_drop_ticks_accepted_in_flight(monkeypatch):
    monkeypatch.setattr(market_worker, "LIVE_BROADCAST_SECONDS", 0.01)

    async def scenario():
        remote = cloud()
        stopped = asyncio.Event()
        started = threading.Event()
        release = threading.Event()
        guard = threading.Lock()
        calls: list[list[dict[str, object]]] = []
        in_flight = 0
        max_in_flight = 0
        loop = asyncio.get_running_loop()

        def broadcast(rows):
            nonlocal in_flight, max_in_flight
            with guard:
                in_flight += 1
                max_in_flight = max(max_in_flight, in_flight)
                calls.append(rows)
                number = len(calls)
            if number == 1:
                started.set()
                assert release.wait(0.2)
            else:
                loop.call_soon_threadsafe(stopped.set)
            with guard:
                in_flight -= 1
            return len(rows)

        remote.broadcast_quote_ticks.side_effect = broadcast
        worker = MarketWorker(remote, client=Mock())
        worker.accept(Tick("AAPL", 100, "yahoo", time=1))
        publishing = asyncio.create_task(worker._publish_ticks(stopped))
        assert await asyncio.to_thread(started.wait, 0.1)
        worker.accept(Tick("AAPL", 101, "yahoo", time=2))
        release.set()

        await asyncio.wait_for(publishing, 0.3)

        assert max_in_flight == 1
        assert [[row["price"] for row in batch] for batch in calls] == [[100], [101]]

    asyncio.run(scenario())


def test_quiet_market_makes_no_broadcast_request_and_still_reconciles(monkeypatch):
    monkeypatch.setattr(market_worker, "LIVE_BROADCAST_SECONDS", 0.01)

    async def scenario():
        remote = cloud()
        worker = MarketWorker(remote, stream=IdleStream(), client=Mock())
        worker.refresh_symbols = AsyncMock()
        worker.claim_until_empty = AsyncMock(return_value=0)
        worker.recover_quotes = AsyncMock()
        worker.refresh_cached_bars = AsyncMock()
        stopped = asyncio.Event()

        asyncio.get_running_loop().call_later(0.035, stopped.set)
        await asyncio.wait_for(worker._publish_ticks(stopped), 0.1)
        assert await worker.reconcile_once() is True

        remote.broadcast_quote_ticks.assert_not_called()
        worker.refresh_symbols.assert_awaited_once()
        worker.recover_quotes.assert_awaited_once()

    asyncio.run(scenario())


def test_stop_event_interrupts_publisher_wait(monkeypatch):
    monkeypatch.setattr(market_worker, "LIVE_BROADCAST_SECONDS", 30.0)

    async def scenario():
        worker = MarketWorker(cloud(), client=Mock())
        stopped = asyncio.Event()
        task = asyncio.create_task(worker._publish_ticks(stopped))
        await asyncio.sleep(0)
        stopped.set()
        await asyncio.wait_for(task, timeout=0.1)

    asyncio.run(scenario())


def test_stop_event_interrupts_reconciliation_wait_without_waiting_thirty_seconds():
    """A SIGTERM must not make a service manager wait out the polling interval."""

    async def run() -> None:
        remote = cloud()
        remote.documents.return_value = {}
        remote.claim_request.return_value = None
        stopped = asyncio.Event()
        worker = MarketWorker(remote, stream=IdleStream(), client=Mock())
        worker.recover_quotes = AsyncMock()
        task = asyncio.create_task(worker.run(stopped))
        await asyncio.sleep(0)
        stopped.set()
        await asyncio.wait_for(task, timeout=0.1)

    asyncio.run(run())


def test_pre_set_stop_does_not_fetch_documents_or_open_provider_work():
    """A service stopped during boot must not start a provider connection anyway."""

    async def run() -> None:
        remote = cloud()
        stopped = asyncio.Event()
        stopped.set()
        worker = MarketWorker(remote, client=Mock())

        await worker.run(stopped)

        remote.documents.assert_not_called()

    asyncio.run(run())


def test_one_reconciliation_drains_requests_recovers_and_flushes_in_order():
    worker = MarketWorker(cloud(), client=Mock())
    calls: list[str] = []
    worker.refresh_symbols = AsyncMock(side_effect=lambda: calls.append("documents"))
    worker.claim_until_empty = AsyncMock(side_effect=lambda: calls.append("requests"))
    worker.recover_quotes = AsyncMock(side_effect=lambda: calls.append("recovery"))
    worker.refresh_cached_bars = AsyncMock(side_effect=lambda: calls.append("bars"))
    worker.flush_quotes_async = AsyncMock(side_effect=lambda: calls.append("flush"))

    assert asyncio.run(worker.reconcile_once()) is True

    assert calls == ["documents", "requests", "recovery", "bars", "flush"]


def test_reconciliation_is_unhealthy_when_provider_work_failed():
    worker = MarketWorker(cloud(), client=Mock())
    worker.refresh_symbols = AsyncMock()
    worker.claim_until_empty = AsyncMock()
    worker.recover_quotes = AsyncMock(side_effect=lambda: setattr(worker._run_stats, "failed", 1))
    worker.refresh_cached_bars = AsyncMock()
    worker.flush_quotes = Mock()

    assert asyncio.run(worker.reconcile_once()) is False
