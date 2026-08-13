"""
The data plane, tested without a network.

Nothing here reaches upstream: the adapters are exercised against recorded
payloads and the cache against a counting factory. Yahoo being unofficial is
exactly why its parsing must be pinned by tests that do not depend on it being
up today.
"""

import asyncio
import os
import time
from unittest import mock

import pytest

from app.adapters import binance, registry, yahoo
from app.adapters.models import ProviderError, Quote
from app.adapters.yahoo_session import SESSION_TTL_SECONDS, YahooSession
from app.config import TIMEFRAMES
from app.services.market_cache import BarCache, MemoryCache

TF = TIMEFRAMES["1d"]


def yahoo_chart(*, stamps, opens, highs, lows, closes, volumes, meta=None):
    return {
        "chart": {
            "error": None,
            "result": [
                {
                    "meta": meta or {},
                    "timestamp": stamps,
                    "indicators": {
                        "quote": [
                            {
                                "open": opens,
                                "high": highs,
                                "low": lows,
                                "close": closes,
                                "volume": volumes,
                            }
                        ]
                    },
                }
            ],
        }
    }


class TestYahooParsing:
    def test_reads_a_plain_series(self):
        payload = yahoo_chart(
            stamps=[1, 2],
            opens=[10.0, 11.0],
            highs=[12.0, 13.0],
            lows=[9.0, 10.5],
            closes=[11.0, 12.5],
            volumes=[100, 200],
        )
        bars = yahoo.parse_bars(payload, limit=100)

        assert [b.time for b in bars] == [1, 2]
        assert bars[0].close == 11.0
        assert bars[1].volume == 200

    def test_drops_padded_gaps_rather_than_drawing_them_as_zero(self):
        payload = yahoo_chart(
            stamps=[1, 2, 3],
            opens=[10.0, None, 12.0],
            highs=[12.0, None, 13.0],
            lows=[9.0, None, 11.0],
            closes=[11.0, None, 12.5],
            volumes=[100, None, 300],
        )
        bars = yahoo.parse_bars(payload, limit=100)

        assert [b.time for b in bars] == [1, 3]
        assert all(b.close > 0 for b in bars)

    def test_missing_volume_is_zero_not_a_dropped_bar(self):
        payload = yahoo_chart(
            stamps=[1],
            opens=[10.0],
            highs=[12.0],
            lows=[9.0],
            closes=[11.0],
            volumes=[None],
        )
        bars = yahoo.parse_bars(payload, limit=100)

        assert len(bars) == 1
        assert bars[0].volume == 0

    def test_keeps_the_newest_bars_when_the_cap_bites(self):
        payload = yahoo_chart(
            stamps=[1, 2, 3, 4],
            opens=[1.0] * 4,
            highs=[1.0] * 4,
            lows=[1.0] * 4,
            closes=[1.0, 2.0, 3.0, 4.0],
            volumes=[0] * 4,
        )
        bars = yahoo.parse_bars(payload, limit=2)

        assert [b.time for b in bars] == [3, 4]

    def test_an_empty_result_is_a_missing_symbol(self):
        with pytest.raises(ProviderError) as caught:
            yahoo.parse_bars({"chart": {"result": []}}, limit=10)
        assert caught.value.code == "symbol-not-found"

    def test_an_upstream_error_is_reported_as_one(self):
        payload = {"chart": {"error": {"description": "Not found"}, "result": []}}
        with pytest.raises(ProviderError) as caught:
            yahoo.parse_bars(payload, limit=10)
        assert caught.value.code == "upstream-error"

    def test_search_takes_what_it_can_name(self):
        payload = {
            "quotes": [
                {
                    "symbol": "aapl",
                    "shortname": "Apple Inc.",
                    "quoteType": "EQUITY",
                    "exchange": "NMS",
                },
                {"longname": "No symbol here"},
                {"symbol": "MSFT", "longname": "Microsoft", "quoteType": "EQUITY"},
            ]
        }
        hits = yahoo.parse_search(payload, limit=10)

        assert [h.symbol for h in hits] == ["AAPL", "MSFT"]
        assert hits[0].name == "Apple Inc."


class TestBinanceParsing:
    def test_reads_klines_and_converts_milliseconds(self):
        payload = [[1700000000000, "10.0", "12.0", "9.0", "11.0", "5.5", 0]]
        bars = binance.parse_bars(payload)

        assert len(bars) == 1
        assert bars[0].time == 1700000000
        assert bars[0].high == 12.0

    def test_skips_rows_that_are_not_candles(self):
        payload = [[1700000000000, "1", "2", "0.5", "1.5", "3"], "nonsense", [1, 2]]
        assert len(binance.parse_bars(payload)) == 1

    def test_derives_the_previous_close_from_the_24h_change(self):
        quote = binance.parse_quote("BTCUSDT", {"lastPrice": "110.0", "priceChange": "10.0"})

        assert quote.price == 110.0
        assert quote.previous_close == 100.0
        assert quote.change == 10.0
        assert quote.change_percent == pytest.approx(10.0)

    def test_a_quote_with_no_price_is_refused(self):
        with pytest.raises(ProviderError) as caught:
            binance.parse_quote("BTCUSDT", {})
        assert caught.value.code == "no-price"

    def test_a_series_that_is_not_a_list_is_refused(self):
        with pytest.raises(ProviderError):
            binance.parse_bars({"not": "a series"})


class TestRouting:
    @pytest.mark.parametrize("symbol", ["BTCUSDT", "ethusdt", "SOLUSDC", "XRPFDUSD"])
    def test_pairs_go_to_binance(self, symbol):
        assert registry.provider_for(symbol) == "binance"

    @pytest.mark.parametrize("symbol", ["AAPL", "VOO", "BRK.B", "^GSPC", "usdt"])
    def test_everything_else_goes_to_yahoo(self, symbol):
        # "USDT" alone is a ticker, not a pair: there is no base asset in front.
        assert registry.provider_for(symbol) == "yahoo"

    def test_symbols_are_normalised_before_anything_looks_at_them(self):
        assert registry.normalize_symbol("  aapl \n") == "AAPL"


class TestMemoryCache:
    def test_serves_a_second_ask_without_calling_upstream(self):
        calls = 0

        async def factory():
            nonlocal calls
            calls += 1
            return {"price": 1}

        cache = MemoryCache(ttl=60)

        async def run():
            await cache.fetch("AAPL", factory)
            await cache.fetch("AAPL", factory)

        asyncio.run(run())
        assert calls == 1

    def test_asks_again_once_the_entry_is_stale(self):
        calls = 0

        async def factory():
            nonlocal calls
            calls += 1
            return calls

        cache = MemoryCache(ttl=0.01)

        async def run():
            first = await cache.fetch("AAPL", factory)
            time.sleep(0.02)
            second = await cache.fetch("AAPL", factory)
            return first, second

        first, second = asyncio.run(run())
        assert (first, second) == (1, 2)
        assert calls == 2

    def test_concurrent_asks_for_one_key_make_one_upstream_call(self):
        calls = 0

        async def factory():
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return "quote"

        cache = MemoryCache(ttl=60)

        async def run():
            return await asyncio.gather(*(cache.fetch("AAPL", factory) for _ in range(5)))

        results = asyncio.run(run())

        assert results == ["quote"] * 5
        assert calls == 1, "five panels asking at once must not be five requests"

    def test_different_keys_are_not_coalesced_together(self):
        seen = []

        async def factory_for(symbol):
            async def factory():
                seen.append(symbol)
                await asyncio.sleep(0.01)
                return symbol

            return factory

        cache = MemoryCache(ttl=60)

        async def run():
            a = await factory_for("AAPL")
            b = await factory_for("MSFT")
            await asyncio.gather(cache.fetch("AAPL", a), cache.fetch("MSFT", b))

        asyncio.run(run())
        assert sorted(seen) == ["AAPL", "MSFT"]

    def test_a_failed_fetch_is_not_cached(self):
        calls = 0

        async def factory():
            nonlocal calls
            calls += 1
            raise ProviderError("unreachable", "down")

        cache = MemoryCache(ttl=60)

        async def run():
            for _ in range(2):
                with pytest.raises(ProviderError):
                    await cache.fetch("AAPL", factory)

        asyncio.run(run())
        assert calls == 2, "a refusal must not be remembered as an answer"


class TestBarCache:
    def test_survives_a_restart(self, tmp_path):
        calls = 0

        async def factory():
            nonlocal calls
            calls += 1
            return binance.parse_bars([[1700000000000, "1", "2", "0.5", "1.5", "3"]])

        async def run(cache):
            return await cache.fetch("BTCUSDT", "1d", 60, factory)

        first = asyncio.run(run(BarCache(tmp_path)))
        # A brand new cache object over the same directory is what a restart is.
        second = asyncio.run(run(BarCache(tmp_path)))

        assert calls == 1
        assert first == second
        assert first[0].close == 1.5

    def test_refetches_once_the_file_is_stale(self, tmp_path):
        calls = 0

        async def factory():
            nonlocal calls
            calls += 1
            return binance.parse_bars([[1700000000000, "1", "2", "0.5", str(calls), "3"]])

        cache = BarCache(tmp_path)

        async def run():
            await cache.fetch("BTCUSDT", "1d", 0.01, factory)
            time.sleep(0.02)
            return await cache.fetch("BTCUSDT", "1d", 0.01, factory)

        bars = asyncio.run(run())
        assert calls == 2
        assert bars[0].close == 2.0

    def test_can_recover_a_recent_expired_entry_after_an_upstream_failure(self, tmp_path):
        cache = BarCache(tmp_path)
        expected = binance.parse_bars([[1700000000000, "1", "2", "0.5", "1.5", "3"]])
        cache.write("BTCUSDT", "1d", expected)

        assert cache.read("BTCUSDT", "1d", 0) is None
        assert cache.read_stale("BTCUSDT", "1d", 60) == expected

    def test_will_not_recover_an_unboundedly_old_entry(self, tmp_path):
        cache = BarCache(tmp_path)
        expected = binance.parse_bars([[1700000000000, "1", "2", "0.5", "1.5", "3"]])
        cache.write("BTCUSDT", "1d", expected)
        path = cache._path_for("BTCUSDT", "1d")
        old = time.time() - 120
        os.utime(path, (old, old))

        assert cache.read_stale("BTCUSDT", "1d", 60) is None

    def test_a_corrupt_file_costs_a_refetch_not_an_error(self, tmp_path):
        cache = BarCache(tmp_path)
        (tmp_path / "BTCUSDT.1d.json").write_text("{ not json", encoding="utf-8")

        async def factory():
            return binance.parse_bars([[1700000000000, "1", "2", "0.5", "1.5", "3"]])

        bars = asyncio.run(cache.fetch("BTCUSDT", "1d", 60, factory))
        assert len(bars) == 1

    def test_a_symbol_cannot_become_a_path(self, tmp_path):
        cache = BarCache(tmp_path)
        path = cache._path_for("../../etc/passwd", "1d")

        assert path.parent == tmp_path
        assert ".." not in path.name


class TestTimeframes:
    def test_every_frame_names_both_providers_and_caps_its_range(self):
        for key, frame in TIMEFRAMES.items():
            assert frame.key == key
            assert frame.yahoo_interval and frame.yahoo_range
            assert frame.binance_interval
            assert frame.limit > 0, "an uncapped fetch is how a range=max query ends in OOM"
            assert frame.ttl > 0

    def test_fifteen_minutes_stays_inside_yahoos_sixty_day_retention_edge(self):
        assert TIMEFRAMES["15m"].yahoo_range == "59d"


def quote_payload(*rows):
    return {"quoteResponse": {"error": None, "result": list(rows)}}


class TestYahooBatchParsing:
    def test_reads_every_quote_in_one_response(self):
        quotes = yahoo.parse_quotes(
            quote_payload(
                {
                    "symbol": "aapl",
                    "regularMarketPrice": 312.41,
                    "regularMarketPreviousClose": 333.43,
                    "currency": "usd",
                    "marketState": "POSTPOST",
                    "shortName": "Apple Inc.",
                },
                {"symbol": "MSFT", "regularMarketPrice": 500.0},
            )
        )

        assert [q.symbol for q in quotes] == ["AAPL", "MSFT"]
        assert quotes[0].currency == "USD"
        # Canonical, not Yahoo's doubled word: the REST endpoint says POSTPOST
        # and the socket says POST for the same session, so both are mapped
        # into one vocabulary the client can branch on.
        assert quotes[0].market_state == "POST"
        assert quotes[0].name == "Apple Inc."
        assert quotes[0].change == pytest.approx(312.41 - 333.43)

    def test_a_symbol_with_no_price_is_left_out_rather_than_faked(self):
        quotes = yahoo.parse_quotes(
            quote_payload({"symbol": "GOOD", "regularMarketPrice": 1.0}, {"symbol": "BAD"})
        )
        assert [q.symbol for q in quotes] == ["GOOD"]

    def test_a_quote_with_no_previous_close_reports_no_change(self):
        quote = yahoo.parse_quotes(quote_payload({"symbol": "X", "regularMarketPrice": 10.0}))[0]
        assert quote.previous_close is None
        assert quote.change is None
        assert quote.change_percent is None

    def test_an_upstream_error_is_reported_rather_than_read_as_empty(self):
        with pytest.raises(ProviderError):
            yahoo.parse_quotes({"quoteResponse": {"error": "Invalid crumb", "result": None}})

    def test_a_response_that_is_not_one_is_refused(self):
        for payload in ([], "nonsense", {"finance": {}}):
            with pytest.raises(ProviderError):
                yahoo.parse_quotes(payload)


class TestYahooSession:
    def test_reuses_a_fresh_crumb_instead_of_negotiating_again(self):
        session = YahooSession()
        calls = 0

        async def negotiate(_client):
            nonlocal calls
            calls += 1
            return "CRUMB"

        session._negotiate = negotiate  # type: ignore[assignment]

        async def run():
            return [await session.crumb(None) for _ in range(3)]  # type: ignore[arg-type]

        assert asyncio.run(run()) == ["CRUMB"] * 3
        assert calls == 1

    def test_ten_symbols_arriving_together_negotiate_once(self):
        session = YahooSession()
        calls = 0

        async def negotiate(_client):
            nonlocal calls
            calls += 1
            await asyncio.sleep(0.02)
            return "CRUMB"

        session._negotiate = negotiate  # type: ignore[assignment]

        async def run():
            return await asyncio.gather(*(session.crumb(None) for _ in range(10)))  # type: ignore[arg-type]

        assert asyncio.run(run()) == ["CRUMB"] * 10
        assert calls == 1, "a handshake is expensive; ten callers must not each pay for one"

    def test_negotiates_again_once_the_crumb_is_stale(self):
        session = YahooSession()
        calls = 0

        async def negotiate(_client):
            nonlocal calls
            calls += 1
            return f"CRUMB{calls}"

        session._negotiate = negotiate  # type: ignore[assignment]

        async def run():
            first = await session.crumb(None, now=0)  # type: ignore[arg-type]
            # Well past the TTL, which is how a rotation shows up.
            second = await session.crumb(None, now=SESSION_TTL_SECONDS + 1)  # type: ignore[arg-type]
            return first, second

        first, second = asyncio.run(run())
        assert first != second

    def test_forgetting_a_refused_crumb_makes_the_next_call_negotiate(self):
        session = YahooSession()
        calls = 0

        async def negotiate(_client):
            nonlocal calls
            calls += 1
            return f"CRUMB{calls}"

        session._negotiate = negotiate  # type: ignore[assignment]

        async def run():
            await session.crumb(None)  # type: ignore[arg-type]
            session.forget()
            await session.crumb(None)  # type: ignore[arg-type]

        asyncio.run(run())
        assert calls == 2, "a refusal must not leave the same dead crumb in place forever"

    def test_a_page_is_not_a_crumb(self):
        session = YahooSession()

        class Refusing:
            async def get(self, *_args, **_kwargs):
                class Response:
                    status_code = 200
                    text = "<html>Something went wrong</html>"

                return Response()

        assert asyncio.run(session.crumb(Refusing())) is None  # type: ignore[arg-type]


class TestExtendedSessionPricing:
    def test_takes_the_after_hours_price_once_the_bell_has_gone(self):
        quote = yahoo.parse_quotes(
            quote_payload(
                {
                    "symbol": "AAPL",
                    "marketState": "POSTPOST",
                    "regularMarketPrice": 312.41,
                    "regularMarketPreviousClose": 311.0,
                    "postMarketPrice": 312.56,
                }
            )
        )[0]

        assert quote.price == 312.56
        assert quote.extended is True

    def test_takes_the_pre_market_price_before_it(self):
        quote = yahoo.parse_quotes(
            quote_payload(
                {
                    "symbol": "AAPL",
                    "marketState": "PRE",
                    "regularMarketPrice": 312.41,
                    "preMarketPrice": 313.90,
                }
            )
        )[0]

        assert quote.price == 313.90
        assert quote.extended is True

    def test_measures_change_against_the_regular_close_even_then(self):
        # "How is it doing today", not "how far has it drifted since the bell":
        # the second is a different and far less useful question at a glance.
        quote = yahoo.parse_quotes(
            quote_payload(
                {
                    "symbol": "AAPL",
                    "marketState": "POSTPOST",
                    "regularMarketPrice": 312.41,
                    "regularMarketPreviousClose": 300.0,
                    "postMarketPrice": 315.0,
                }
            )
        )[0]

        assert quote.previous_close == 300.0
        assert quote.change == pytest.approx(15.0)
        assert quote.change_percent == pytest.approx(5.0)

    def test_falls_back_when_the_extended_session_has_not_traded_yet(self):
        quote = yahoo.parse_quotes(
            quote_payload({"symbol": "AAPL", "marketState": "POST", "regularMarketPrice": 312.41})
        )[0]

        # A stale number beats an empty row.
        assert quote.price == 312.41
        assert quote.extended is False

    def test_leaves_the_regular_price_alone_while_the_market_is_open(self):
        quote = yahoo.parse_quotes(
            quote_payload(
                {
                    "symbol": "AAPL",
                    "marketState": "REGULAR",
                    "regularMarketPrice": 312.41,
                    "postMarketPrice": 999.0,
                }
            )
        )[0]

        assert quote.price == 312.41
        assert quote.extended is False


class TestTheBatchFallback:
    def test_a_rate_limit_is_reported_rather_than_multiplied(self):
        """
        The fallback turns one request into one per symbol. Answering a quota
        refusal with it spends ten times the budget at the exact moment there
        is none left — and decision 8.4 is written around a daily ceiling.
        """
        calls: list[str] = []

        async def refuse_batch(_client, _symbols):
            calls.append("batch")
            raise ProviderError("rate-limited", "Yahoo is rate limiting this address")

        async def one_by_one(_client, symbol):
            calls.append(f"one:{symbol}")
            raise AssertionError("the fallback must not run for a rate limit")

        with (
            mock.patch.object(yahoo, "fetch_quotes", refuse_batch),
            mock.patch.object(yahoo, "fetch_quote", one_by_one),
        ):
            quotes, failed = asyncio.run(registry._yahoo_quotes(None, ["AAPL", "MSFT", "NVDA"]))

        assert calls == ["batch"]
        assert quotes == []
        # Every symbol carries the reason, which is what decision 8.8 renders.
        assert [symbol for symbol, _ in failed] == ["AAPL", "MSFT", "NVDA"]
        assert {error.code for _, error in failed} == {"rate-limited"}

    def test_any_other_refusal_still_falls_back(self):
        # The handshake is the fragile thing the fallback exists for, and this
        # must not have turned that off.
        calls: list[str] = []

        async def refuse_batch(_client, _symbols):
            calls.append("batch")
            raise ProviderError("upstream-error", "the crumb rotated")

        async def one_by_one(_client, symbol):
            calls.append(f"one:{symbol}")
            return Quote(
                symbol=symbol, price=1.0, currency="USD", previous_close=None, provider="yahoo"
            )

        with (
            mock.patch.object(yahoo, "fetch_quotes", refuse_batch),
            mock.patch.object(yahoo, "fetch_quote", one_by_one),
        ):
            quotes, failed = asyncio.run(registry._yahoo_quotes(None, ["AAPL", "MSFT"]))

        assert calls == ["batch", "one:AAPL", "one:MSFT"]
        assert [q.symbol for q in quotes] == ["AAPL", "MSFT"]
        assert failed == []


class TestTheSessionFactTravels:
    def test_an_equity_has_a_session_and_a_pair_does_not(self):
        """
        The client used to answer this by testing `provider !== 'binance'` —
        reading a provider's name to decide behaviour, which decision 8.3
        exists to prevent. It was the last place that leaked.
        """
        assert registry.has_session("AAPL") is True
        assert registry.has_session("SPCX") is True
        assert registry.has_session("BTCUSDT") is False
        assert registry.has_session("ETHUSDT") is False
