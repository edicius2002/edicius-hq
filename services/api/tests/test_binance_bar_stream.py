import asyncio
import json

import pytest

from app.adapters.binance_bar_stream import BinanceBarStream, parse_kline
from app.adapters.models import Bar, BarFocus, LiveBar


def kline(*, symbol: str = "BTCUSDT", timeframe: str = "1m", volume: str = "12.5") -> str:
    return json.dumps(
        {
            "stream": f"{symbol.lower()}@kline_{timeframe}",
            "data": {
                "e": "kline",
                "E": 1_790_076_602_250,
                "s": symbol,
                "k": {
                    "t": 1_790_075_700_000,
                    "i": timeframe,
                    "o": "100",
                    "h": "104",
                    "l": "99",
                    "c": "102",
                    "v": volume,
                    "x": False,
                },
            },
        }
    )


@pytest.mark.parametrize("timeframe", ["1m", "5m", "15m", "1h", "1d", "1w", "1M"])
def test_parse_kline_returns_complete_authoritative_bar(timeframe):
    event = json.dumps(
        {
            "stream": f"btcusdt@kline_{timeframe}",
            "data": {
                "e": "kline",
                "E": 1_790_076_602_250,
                "s": "BTCUSDT",
                "k": {
                    "t": 1_790_075_700_000,
                    "i": timeframe,
                    "o": "100",
                    "h": "104",
                    "l": "99",
                    "c": "102",
                    "v": "12.5",
                    "x": False,
                },
            },
        }
    )

    update = parse_kline(event)

    assert update == LiveBar(
        symbol="BTCUSDT",
        timeframe=timeframe,
        extended=False,
        as_of=1_790_076_602.25,
        bar=Bar(time=1_790_075_700, open=100, high=104, low=99, close=102, volume=12.5),
        provider="binance",
    )


def test_parse_kline_keeps_a_volume_only_change():
    first = parse_kline(kline(volume="12.5"))
    update = parse_kline(kline(volume="13"))

    assert first is not None
    assert update is not None
    assert update.bar.volume == 13
    assert update.bar.open == first.bar.open
    assert update.bar.high == first.bar.high
    assert update.bar.low == first.bar.low
    assert update.bar.close == first.bar.close


@pytest.mark.parametrize(
    "message",
    [
        "not json",
        json.dumps({"data": {"s": "BTCUSDT", "k": {"i": "1m"}}}),
        kline(timeframe="2h"),
        kline(volume="nan"),
    ],
)
def test_parse_kline_ignores_malformed_or_unsupported_frames(message):
    assert parse_kline(message) is None


class FakeSocket:
    def __init__(self, frames: list[str]) -> None:
        self._frames = frames

    async def __aenter__(self) -> "FakeSocket":
        return self

    async def __aexit__(self, *_: object) -> bool:
        return False

    def __aiter__(self):
        async def frames():
            for frame in self._frames:
                yield frame

        return frames()


async def _no_wait(_seconds: float) -> None:
    """Reconnect immediately in tests that exercise a changed subscription."""


def test_changed_binance_focus_reconnects_with_the_sorted_desired_set():
    opened: list[str] = []
    sockets = [
        FakeSocket([kline(symbol="BTCUSDT", timeframe="5m")] * 2),
        FakeSocket([kline(symbol="SOLUSDT", timeframe="1d")]),
    ]

    def connect(url: str) -> FakeSocket:
        opened.append(url)
        return sockets[min(len(opened) - 1, len(sockets) - 1)]

    async def run() -> list[LiveBar]:
        stream = BinanceBarStream(connect=connect, sleep=_no_wait)
        await stream.watch(
            {
                BarFocus("ETHUSDT", "1m", False),
                BarFocus("BTCUSDT", "5m", False),
                BarFocus("AAPL", "1m", False),
            }
        )
        bars = stream.bars()
        first = await anext(bars)
        await stream.watch(
            {
                BarFocus("ETHUSDT", "1m", False),
                BarFocus("BTCUSDT", "5m", False),
                BarFocus("SOLUSDT", "1d", False),
                BarFocus("AAPL", "1m", False),
            }
        )
        second = await anext(bars)
        await bars.aclose()
        return [first, second]

    bars = asyncio.run(run())

    assert [bar.symbol for bar in bars] == ["BTCUSDT", "SOLUSDT"]
    assert opened[0].endswith("?streams=btcusdt@kline_5m/ethusdt@kline_1m")
    assert opened[1].endswith("?streams=btcusdt@kline_5m/ethusdt@kline_1m/solusdt@kline_1d")
