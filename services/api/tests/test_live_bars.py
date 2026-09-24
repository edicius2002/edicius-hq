import asyncio
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from app.adapters.live_bars import CompositeBarStream
from app.adapters.models import Bar, BarFocus, LiveBar

NY = ZoneInfo("America/New_York")


def timestamp(value: str) -> float:
    return datetime.fromisoformat(value).replace(tzinfo=NY).timestamp()


OPEN_MARKET = timestamp("2026-09-22T10:00:00")


def live_bar(symbol: str, provider: str) -> LiveBar:
    return LiveBar(
        symbol=symbol,
        timeframe="1m",
        extended=False,
        as_of=100,
        bar=Bar(time=100, open=1, high=2, low=1, close=2, volume=3),
        provider=provider,
    )


class FakeBinance:
    def __init__(self, bars: list[LiveBar] | None = None) -> None:
        self.watched: list[set[BarFocus]] = []
        self._bars = bars or []
        self.released = asyncio.Event()

    async def watch(self, focuses: set[BarFocus]) -> None:
        self.watched.append(set(focuses))

    async def bars(self):
        for bar in self._bars:
            yield bar
        await self.released.wait()


class FakeYahoo:
    def __init__(self, results: list[object]) -> None:
        self.results = list(results)
        self.fetches: list[BarFocus] = []
        self.released = asyncio.Event()

    async def fetch(self, focus: BarFocus) -> LiveBar | None:
        self.fetches.append(focus)
        if not self.results:
            await self.released.wait()
            return None
        result = self.results.pop(0)
        if isinstance(result, BaseException):
            raise result
        return result


async def _advance_once() -> None:
    await asyncio.sleep(0)


def test_watch_splits_providers_and_deduplicates_live_acquisition():
    async def run() -> tuple[FakeBinance, FakeYahoo, list[LiveBar]]:
        binance = FakeBinance([live_bar("BTCUSDT", "binance")])
        yahoo = FakeYahoo([live_bar("AAPL", "yahoo")])
        stream = CompositeBarStream(binance, yahoo, clock=lambda: OPEN_MARKET, sleep=_advance_once)
        focuses = {
            BarFocus("BTCUSDT", "1m", False),
            BarFocus("AAPL", "1m", False),
        }
        await stream.watch(focuses)
        await stream.watch(set(focuses))
        bars = stream.bars()
        got = [await asyncio.wait_for(anext(bars), timeout=1) for _ in range(2)]
        await bars.aclose()
        return binance, yahoo, got

    binance, yahoo, got = asyncio.run(run())

    assert binance.watched == [
        {BarFocus("BTCUSDT", "1m", False)},
        {BarFocus("BTCUSDT", "1m", False)},
    ]
    assert yahoo.fetches == [BarFocus("AAPL", "1m", False)]
    assert {bar.symbol for bar in got} == {"BTCUSDT", "AAPL"}


def test_yahoo_polls_immediately_then_every_five_seconds_and_stops_when_removed():
    async def run() -> tuple[list[BarFocus], list[float]]:
        now = [timestamp("2026-09-22T10:00:00")]
        waits: list[float] = []
        yahoo = FakeYahoo([live_bar("AAPL", "yahoo"), live_bar("AAPL", "yahoo")])

        async def sleep(seconds: float) -> None:
            waits.append(seconds)
            now[0] += seconds
            await asyncio.sleep(0)

        stream = CompositeBarStream(FakeBinance(), yahoo, clock=lambda: now[0], sleep=sleep)
        focus = BarFocus("AAPL", "1m", False)
        await stream.watch({focus})
        await _advance_once()
        await _advance_once()
        await stream.watch(set())
        await _advance_once()
        fetches = list(yahoo.fetches)
        await stream.close()
        return fetches, waits

    fetches, waits = asyncio.run(run())

    assert fetches == [BarFocus("AAPL", "1m", False), BarFocus("AAPL", "1m", False)]
    assert waits[:2] == [5.0, 5.0]
    assert len(fetches) == 2


def test_closed_yahoo_session_sleeps_until_next_weekday_open_without_fetching():
    async def run() -> tuple[list[BarFocus], list[float]]:
        now = [timestamp("2026-09-22T03:00:00")]
        waits: list[float] = []
        yahoo = FakeYahoo([live_bar("AAPL", "yahoo")])

        async def sleep(seconds: float) -> None:
            waits.append(seconds)
            now[0] += seconds
            await asyncio.sleep(0)

        stream = CompositeBarStream(FakeBinance(), yahoo, clock=lambda: now[0], sleep=sleep)
        focus = BarFocus("AAPL", "1m", False)
        await stream.watch({focus})
        await _advance_once()
        await _advance_once()
        await stream.close()
        return yahoo.fetches, waits

    fetches, waits = asyncio.run(run())

    assert fetches == [BarFocus("AAPL", "1m", False)]
    assert waits[0] == 3600.0


def test_yahoo_failures_use_bounded_backoff_then_reset_after_a_valid_bar():
    async def run() -> list[float]:
        waits: list[float] = []
        yahoo = FakeYahoo(
            [
                RuntimeError("one"),
                RuntimeError("two"),
                RuntimeError("three"),
                RuntimeError("four"),
                RuntimeError("five"),
                live_bar("AAPL", "yahoo"),
            ]
        )

        async def sleep(seconds: float) -> None:
            waits.append(seconds)
            await asyncio.sleep(0)
            if len(waits) == 6:
                raise asyncio.CancelledError

        stream = CompositeBarStream(FakeBinance(), yahoo, clock=lambda: OPEN_MARKET, sleep=sleep)
        await stream.watch({BarFocus("AAPL", "1m", False)})
        with pytest.raises(asyncio.CancelledError):
            await stream._yahoo_tasks[next(iter(stream._yahoo_tasks))]
        return waits

    waits = asyncio.run(run())

    assert waits == [5.0, 10.0, 20.0, 40.0, 60.0, 5.0]


def test_quiet_binance_does_not_block_yahoo_bar():
    async def run() -> LiveBar:
        binance = FakeBinance()
        yahoo = FakeYahoo([live_bar("AAPL", "yahoo")])
        stream = CompositeBarStream(binance, yahoo, clock=lambda: OPEN_MARKET, sleep=_advance_once)
        await stream.watch({BarFocus("BTCUSDT", "1m", False), BarFocus("AAPL", "1m", False)})
        bars = stream.bars()
        result = await asyncio.wait_for(anext(bars), timeout=1)
        await bars.aclose()
        return result

    result = asyncio.run(run())

    assert result.symbol == "AAPL"


def test_removing_focus_cancels_a_pending_yahoo_wait_promptly():
    async def run() -> bool:
        started = asyncio.Event()
        release = asyncio.Event()

        async def sleep(_seconds: float) -> None:
            started.set()
            await release.wait()

        yahoo = FakeYahoo([live_bar("AAPL", "yahoo")])
        stream = CompositeBarStream(FakeBinance(), yahoo, sleep=sleep)
        focus = BarFocus("AAPL", "1m", False)
        await stream.watch({focus})
        await _advance_once()
        await _advance_once()
        assert started.is_set()
        await stream.watch(set())
        await _advance_once()
        return focus not in stream._yahoo_tasks

    assert asyncio.run(run())
