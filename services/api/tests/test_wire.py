"""
The layer the contract actually lives in.

`Quote`, `Bar` and `SymbolHit` are described twice — once in
`app/adapters/models.py` and once in the browser's `shared/api/market.ts` — and
nothing checked that the JSON between them said what the client reads. The
adapters were well covered and the serialization above them was not, so a
renamed field would have passed every test and broken the page.

These assert the literal keys, because the literal keys are the contract.
"""

import json
import os
from unittest import mock

import pytest
from fastapi.testclient import TestClient

from app.adapters.models import Bar, ProviderError, Quote, SymbolHit
from app.main import app
from app.routers import market as market_router


@pytest.fixture
def client(monkeypatch, tmp_path):
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
    # The quote cache is process-global and outlives a test. Left alone, a
    # symbol answered in one test is served from memory in the next and the
    # stub is never called — which is how the first run of this file reported
    # AAPL twice.
    market_router.quote_cache.clear()
    # Nothing here reaches a network: every upstream is stubbed per test.
    return TestClient(app)


def quote(symbol: str = "AAPL") -> Quote:
    return Quote(
        symbol=symbol,
        price=312.56,
        currency="USD",
        previous_close=311.0,
        provider="yahoo",
        market_state="POST",
        name="Apple Inc.",
        extended=True,
    )


class TestQuotesOnTheWire:
    def test_says_exactly_what_the_client_reads(self, client):
        async def answer(_client, _symbols):
            return [quote()], []

        with mock.patch.object(market_router.registry, "fetch_quotes", answer):
            body = client.get("/api/market/quotes?symbols=AAPL").json()

        assert body["quotes"][0] == {
            "symbol": "AAPL",
            "price": 312.56,
            "currency": "USD",
            "previousClose": 311.0,
            "change": pytest.approx(1.56),
            "changePercent": pytest.approx(0.5016, abs=1e-3),
            "provider": "yahoo",
            "marketState": "POST",
            "name": "Apple Inc.",
            "extended": True,
        }
        assert body["failed"] == []

    def test_a_refused_symbol_travels_beside_the_ones_that_worked(self, client):
        # Decision 8.8, asserted at the layer that has to carry it.
        async def answer(_client, _symbols):
            return [quote()], [("ZZZZ", ProviderError("symbol-not-found", "no such symbol"))]

        with mock.patch.object(market_router.registry, "fetch_quotes", answer):
            body = client.get("/api/market/quotes?symbols=AAPL,ZZZZ").json()

        assert [q["symbol"] for q in body["quotes"]] == ["AAPL"]
        assert body["failed"] == [
            {"symbol": "ZZZZ", "code": "symbol-not-found", "message": "no such symbol"}
        ]

    def test_refuses_a_request_with_no_symbols(self, client):
        assert client.get("/api/market/quotes?symbols=").status_code == 400


class TestBarsOnTheWire:
    def test_says_exactly_what_the_chart_reads(self, client):
        bar = Bar(time=1_786_060_800, open=1.0, high=2.0, low=0.5, close=1.5, volume=100.0)

        async def answer(*_args, **_kwargs):
            return [bar]

        with mock.patch.object(market_router.registry, "fetch_bars", answer):
            body = client.get("/api/market/bars?symbol=AAPL&timeframe=1d").json()

        assert body["symbol"] == "AAPL"
        assert body["timeframe"] == "1d"
        assert body["provider"] == "yahoo"
        assert body["hasSession"] is True
        assert body["stale"] is False
        assert body["bars"] == [
            {
                "time": 1_786_060_800,
                "open": 1.0,
                "high": 2.0,
                "low": 0.5,
                "close": 1.5,
                "volume": 100.0,
            }
        ]

    def test_a_pair_reports_that_its_market_never_closes(self, client):
        async def answer(*_args, **_kwargs):
            return []

        with mock.patch.object(market_router.registry, "fetch_bars", answer):
            body = client.get("/api/market/bars?symbol=BTCUSDT&timeframe=1d").json()

        # The client used to work this out by testing the provider's name.
        assert body["hasSession"] is False
        assert body["provider"] == "binance"

    def test_an_unknown_timeframe_is_refused_rather_than_guessed(self, client):
        assert client.get("/api/market/bars?symbol=AAPL&timeframe=7h").status_code == 400

    def test_a_recent_cached_series_survives_an_upstream_refusal(self, client):
        bar = Bar(time=1_786_060_800, open=1.0, high=2.0, low=0.5, close=1.5, volume=100.0)
        market_router.bar_cache.write("AAPL", "15m", [bar])
        path = market_router.bar_cache._path_for("AAPL", "15m")
        old = path.stat().st_mtime - 60
        os.utime(path, (old, old))

        async def refuse(*_args, **_kwargs):
            raise ProviderError("upstream-error", "Yahoo answered 502")

        with mock.patch.object(market_router.registry, "fetch_bars", refuse):
            response = client.get("/api/market/bars?symbol=AAPL&timeframe=15m")

        assert response.status_code == 200
        assert response.json()["stale"] is True
        assert response.json()["bars"][0]["close"] == 1.5

    def test_a_cached_series_does_not_hide_that_a_symbol_is_gone(self, client):
        bar = Bar(time=1_786_060_800, open=1.0, high=2.0, low=0.5, close=1.5, volume=100.0)
        market_router.bar_cache.write("DELISTED", "1d", [bar])
        path = market_router.bar_cache._path_for("DELISTED", "1d")
        old = path.stat().st_mtime - 301
        os.utime(path, (old, old))

        async def refuse(*_args, **_kwargs):
            raise ProviderError("symbol-not-found", "Yahoo does not know that symbol")

        with mock.patch.object(market_router.registry, "fetch_bars", refuse):
            response = client.get("/api/market/bars?symbol=DELISTED&timeframe=1d")

        assert response.status_code == 404


class TestSearchOnTheWire:
    def test_says_exactly_what_the_picker_reads(self, client):
        async def answer(_client, _query, limit=10):
            return [SymbolHit(symbol="AAPL", name="Apple Inc.", kind="EQUITY", exchange="NMS")]

        with mock.patch.object(market_router.registry, "search", answer):
            body = client.get("/api/market/search?q=apple").json()

        assert body["results"] == [
            {"symbol": "AAPL", "name": "Apple Inc.", "kind": "EQUITY", "exchange": "NMS"}
        ]


class TestTheErrorShape:
    def test_a_provider_refusal_carries_its_code_to_the_client(self, client):
        # The client tells "the provider is down" from "no such symbol" by this
        # code alone, so it has to survive the trip.
        async def refuse(*_args, **_kwargs):
            raise ProviderError("rate-limited", "Yahoo is rate limiting this address")

        with mock.patch.object(market_router.registry, "fetch_bars", refuse):
            response = client.get("/api/market/bars?symbol=AAPL&timeframe=1d")

        assert response.status_code == 429
        detail = response.json()["detail"]
        assert detail["code"] == "rate-limited"


class TestTheStreamFrames:
    def test_a_tick_is_written_in_the_shape_the_browser_parses(self):
        from app.adapters.models import Tick

        payload = market_router.tick_payload(
            Tick(
                symbol="AAPL",
                price=312.56,
                provider="yahoo",
                market_state="POST",
                change_percent=0.5,
                time=1_786_060_798.0,
            )
        )

        assert payload == {
            "symbol": "AAPL",
            "price": 312.56,
            "marketState": "POST",
            "extended": True,
            "changePercent": 0.5,
            "time": 1_786_060_798.0,
        }

    def test_an_event_is_framed_the_way_EventSource_expects(self):
        # Two newlines end an event; one would make the browser wait forever.
        assert market_router.sse("quotes", [1]) == "event: quotes\ndata: [1]\n\n"
        assert json.loads(market_router.sse("open", {"a": 1}).split("data: ")[1]) == {"a": 1}
