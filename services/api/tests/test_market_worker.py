"""The Pi market worker owns provider acquisition, never browser requests."""

from __future__ import annotations

import asyncio
import contextlib
from datetime import UTC, datetime
from unittest.mock import AsyncMock, Mock
from uuid import UUID

from app.adapters import registry
from app.adapters.models import Quote, Tick
from app.services.collector_cloud import CollectorRequest
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


def cloud() -> Mock:
    result = Mock()
    result.owner_id = OWNER
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


def test_symbols_union_three_documents_without_duplicates():
    """Removing source validation would poll malformed or duplicate symbols."""
    assert MarketWorker(cloud()).desired_symbols() == ("AAPL", "BTC-USD", "BAD")


def test_partial_portfolio_position_still_owns_its_symbol():
    """Legacy valuation fields must not silently stop quote ownership."""
    remote = cloud()
    remote.documents.return_value["portfolio"] = {"positions": [{"symbol": "  msft  "}]}

    assert MarketWorker(remote).desired_symbols() == ("AAPL", "MSFT")


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


def test_stop_event_interrupts_reconciliation_wait_without_waiting_thirty_seconds():
    """A SIGTERM must not make a service manager wait out the polling interval."""

    class IdleStream:
        async def watch(self, _symbols):
            return None

        async def ticks(self):
            await asyncio.Event().wait()
            yield  # pragma: no cover - establishes this as an async generator

    async def run() -> None:
        remote = cloud()
        remote.documents.return_value = {}
        remote.claim_request.return_value = None
        stopped = asyncio.Event()
        worker = MarketWorker(remote, stream=IdleStream(), client=Mock())
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
    worker.flush_quotes = Mock(side_effect=lambda: calls.append("flush"))

    assert asyncio.run(worker.reconcile_once()) is True

    assert calls == ["documents", "requests", "recovery", "flush"]


def test_reconciliation_is_unhealthy_when_provider_work_failed():
    worker = MarketWorker(cloud(), client=Mock())
    worker.refresh_symbols = AsyncMock()
    worker.claim_until_empty = AsyncMock()
    worker.recover_quotes = AsyncMock(side_effect=lambda: setattr(worker._run_stats, "failed", 1))
    worker.flush_quotes = Mock()

    assert asyncio.run(worker.reconcile_once()) is False
