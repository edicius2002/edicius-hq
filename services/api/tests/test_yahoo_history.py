"""
Yahoo's historical series, normalized so every candle starts where the live
candle for the same period will.

Pinned against real responses recorded mid-session on 2026-09-24 (10:19 New
York), where Yahoo appended a row stamped at the quote time to every series but
the daily ones. Left alone, that row is a candle the live path can never match.
"""

import json
from datetime import datetime
from itertools import pairwise
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.adapters import yahoo
from app.adapters.yahoo_buckets import bucket_start

NY = ZoneInfo("America/New_York")
FIXTURES = Path(__file__).parent / "fixtures"


def ny(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=NY).timestamp())


def fixture(name: str) -> dict:
    return json.loads((FIXTURES / f"yahoo_chart_aapl_{name}_2026-09-24.json").read_text())


def raw_rows(payload: dict) -> list[tuple]:
    """Every row as Yahoo sent it: (time, open, high, low, close, volume)."""
    result = payload["chart"]["result"][0]
    quote = result["indicators"]["quote"][0]
    return list(
        zip(
            result["timestamp"],
            quote["open"],
            quote["high"],
            quote["low"],
            quote["close"],
            quote["volume"],
            strict=True,
        )
    )


def chart(rows: list[tuple]) -> dict:
    """A chart payload from (time, open, high, low, close, volume) rows."""
    columns = list(zip(*rows, strict=True)) if rows else [[]] * 6
    return {
        "chart": {
            "error": None,
            "result": [
                {
                    "meta": {},
                    "timestamp": list(columns[0]),
                    "indicators": {
                        "quote": [
                            {
                                "open": list(columns[1]),
                                "high": list(columns[2]),
                                "low": list(columns[3]),
                                "close": list(columns[4]),
                                "volume": list(columns[5]),
                            }
                        ]
                    },
                }
            ],
        }
    }


ALL_SERIES = [
    ("1m", "1m"),
    ("5m", "5m"),
    ("15m", "15m"),
    ("1h", "1h"),
    ("1h", "1h_ext"),
    ("1d", "1d"),
    ("1d", "1d_ext"),
    ("1w", "1w"),
    ("1M", "1mo"),
]


@pytest.mark.parametrize(("timeframe", "name"), ALL_SERIES)
def test_every_candle_starts_at_its_bucket(timeframe, name):
    bars = yahoo.parse_bars(fixture(name), timeframe, limit=1000)

    assert bars
    assert all(bar.time == bucket_start(bar.time, timeframe) for bar in bars)
    assert all(a.time < b.time for a, b in pairwise(bars))


@pytest.mark.parametrize(("timeframe", "name"), ALL_SERIES)
def test_only_the_trailing_row_is_touched(timeframe, name):
    # Every row but Yahoo's last is already a candle and must come through
    # exactly as sent; only the trailing snapshot is folded or moved.
    rows = [row for row in raw_rows(fixture(name)) if None not in row[:5]]
    bars = yahoo.parse_bars(fixture(name), timeframe, limit=1000)

    untouched = [(b.time, b.open, b.high, b.low, b.close, b.volume) for b in bars]
    assert untouched[: len(rows) - 2] == [
        (t, o, h, low, c, float(v or 0)) for t, o, h, low, c, v in rows[: len(rows) - 2]
    ]


@pytest.mark.parametrize(
    ("timeframe", "name", "last_candle"),
    [
        ("5m", "5m", "2026-09-24T10:15:00"),
        ("15m", "15m", "2026-09-24T10:15:00"),
        ("1h", "1h", "2026-09-24T09:30:00"),
        ("1h", "1h_ext", "2026-09-24T09:30:00"),
    ],
)
def test_the_intraday_snapshot_folds_into_the_candle_in_progress(timeframe, name, last_candle):
    rows = raw_rows(fixture(name))
    candle, snapshot = rows[-2], rows[-1]
    assert candle[0] == ny(last_candle)
    bars = yahoo.parse_bars(fixture(name), timeframe, limit=1000)

    last = bars[-1]
    assert len(bars) == len(rows) - 1
    assert last.time == ny(last_candle)
    assert last.open == candle[1]
    assert last.high == max(candle[2], snapshot[2])
    assert last.low == min(candle[3], snapshot[3])
    assert last.close == snapshot[4]
    # The snapshot carries no volume of its own.
    assert snapshot[5] == 0
    assert last.volume == candle[5]


def test_a_snapshot_in_a_new_minute_starts_that_minute():
    # Recorded at 10:19:01: Yahoo padded the 10:19 row with nulls and then
    # appended the snapshot, so the 10:19 candle is the snapshot alone.
    rows = raw_rows(fixture("1m"))
    snapshot = rows[-1]
    bars = yahoo.parse_bars(fixture("1m"), "1m", limit=1000)

    assert [b.time for b in bars[-2:]] == [ny("2026-09-24T10:18:00"), ny("2026-09-24T10:19:00")]
    last = bars[-1]
    assert (last.open, last.high, last.low, last.close, last.volume) == (
        snapshot[1],
        snapshot[2],
        snapshot[3],
        snapshot[4],
        0.0,
    )


@pytest.mark.parametrize(
    ("timeframe", "name", "period_start"),
    [
        ("1w", "1w", "2026-09-21T00:00:00"),
        ("1M", "1mo", "2026-09-01T00:00:00"),
    ],
)
def test_todays_row_folds_into_the_current_week_or_month(timeframe, name, period_start):
    # Yahoo's period row covers the days before today; the trailing row is
    # today's daily bar. Together they are the period so far.
    rows = raw_rows(fixture(name))
    period, today = rows[-2], rows[-1]
    assert period[0] == ny(period_start)
    bars = yahoo.parse_bars(fixture(name), timeframe, limit=1000)

    last = bars[-1]
    assert len(bars) == len(rows) - 1
    assert last.time == ny(period_start)
    assert last.open == period[1]
    assert last.high == max(period[2], today[2])
    assert last.low == min(period[3], today[3])
    assert last.close == today[4]
    assert last.volume == period[5] + today[5]


@pytest.mark.parametrize("name", ["1d", "1d_ext"])
def test_a_daily_series_with_no_snapshot_is_unchanged(name):
    rows = raw_rows(fixture(name))
    bars = yahoo.parse_bars(fixture(name), "1d", limit=1000)

    assert [(b.time, b.close, b.volume) for b in bars] == [
        (t, c, float(v)) for t, _o, _h, _l, c, v in rows
    ]


class TestOffGridRows:
    def test_a_snapshot_past_the_last_candle_starts_the_next_one(self):
        bars = yahoo.parse_bars(
            chart(
                [
                    (ny("2026-09-24T10:10:00"), 1.0, 2.0, 0.5, 1.5, 100),
                    (ny("2026-09-24T10:15:03"), 1.7, 1.7, 1.7, 1.7, 0),
                ]
            ),
            "5m",
            limit=100,
        )

        assert [b.time for b in bars] == [ny("2026-09-24T10:10:00"), ny("2026-09-24T10:15:00")]
        assert (bars[1].open, bars[1].close, bars[1].volume) == (1.7, 1.7, 0.0)

    def test_a_row_outside_every_session_is_dropped(self):
        bars = yahoo.parse_bars(
            chart(
                [
                    (ny("2026-09-24T19:55:00"), 1.0, 2.0, 0.5, 1.5, 100),
                    (ny("2026-09-24T20:00:07"), 1.7, 1.7, 1.7, 1.7, 0),
                ]
            ),
            "5m",
            limit=100,
        )

        assert [b.time for b in bars] == [ny("2026-09-24T19:55:00")]
        assert bars[0].close == 1.5

    def test_a_row_older_than_the_last_candle_is_dropped(self):
        bars = yahoo.parse_bars(
            chart(
                [
                    (ny("2026-09-24T10:10:00"), 1.0, 2.0, 0.5, 1.5, 100),
                    (ny("2026-09-24T10:15:00"), 1.5, 1.8, 1.4, 1.6, 50),
                    (ny("2026-09-24T10:05:30"), 9.0, 9.0, 9.0, 9.0, 7),
                ]
            ),
            "5m",
            limit=100,
        )

        assert [(b.time, b.close, b.volume) for b in bars] == [
            (ny("2026-09-24T10:10:00"), 1.5, 100.0),
            (ny("2026-09-24T10:15:00"), 1.6, 50.0),
        ]

    def test_the_cap_applies_after_folding(self):
        # Three rows, two candles: a cap of two keeps both, folded.
        bars = yahoo.parse_bars(
            chart(
                [
                    (ny("2026-09-24T10:05:00"), 1.0, 1.0, 1.0, 1.0, 10),
                    (ny("2026-09-24T10:10:00"), 1.0, 2.0, 0.5, 1.5, 100),
                    (ny("2026-09-24T10:12:00"), 1.6, 2.5, 1.6, 1.6, 0),
                ]
            ),
            "5m",
            limit=2,
        )

        assert [b.time for b in bars] == [ny("2026-09-24T10:05:00"), ny("2026-09-24T10:10:00")]
        assert (bars[1].high, bars[1].close) == (2.5, 1.6)
