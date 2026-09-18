"""The Pi market worker owns provider acquisition, never browser requests."""

from __future__ import annotations

from unittest.mock import Mock
from uuid import UUID

from app.adapters.models import Quote, Tick
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
    assert MarketWorker(cloud()).desired_symbols() == ("AAPL", "BTC-USD")


def test_many_ticks_flush_one_latest_quote_per_window():
    """Writing each tick would turn a busy symbol into five-second-row churn."""
    remote = cloud()
    clock = Clock()
    worker = MarketWorker(remote, clock=clock)
    worker.accept(Tick("AAPL", 100, "yahoo", time=1))
    worker.accept(Tick("AAPL", 101, "yahoo", time=2))
    clock.advance(5)

    worker.flush_quotes()

    remote.upsert_quotes.assert_called_once()
    row = remote.upsert_quotes.call_args.args[0][0]
    assert row["symbol"] == "AAPL"
    assert row["payload"]["price"] == 101


def test_tick_market_time_is_an_integer_for_the_database_column():
    """Passing Binance's fractional seconds to bigint would reject an otherwise good quote."""
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    worker.accept(Tick("AAPL", 101, "yahoo", time=2.25))

    worker.flush_quotes()

    assert remote.upsert_quotes.call_args.args[0][0]["market_time"] == 2
