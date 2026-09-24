import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

from app.adapters.yahoo_buckets import bucket_start

NY = ZoneInfo("America/New_York")
FIXTURES = Path(__file__).parent / "fixtures"


def ny(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=NY).timestamp())


def stamps(name: str) -> list[int]:
    payload = json.loads((FIXTURES / name).read_text())
    return payload["chart"]["result"][0]["timestamp"]


@pytest.mark.parametrize(
    ("timeframe", "fixture"),
    [
        ("1m", "yahoo_chart_aapl_1m_2026-09-24.json"),
        ("5m", "yahoo_chart_aapl_5m_2026-09-24.json"),
        ("15m", "yahoo_chart_aapl_15m_2026-09-24.json"),
        ("1h", "yahoo_chart_aapl_1h_2026-09-24.json"),
        ("1h", "yahoo_chart_aapl_1h_ext_2026-09-24.json"),
        ("1d", "yahoo_chart_aapl_1d_2026-09-24.json"),
        ("1d", "yahoo_chart_aapl_1d_ext_2026-09-24.json"),
        ("1w", "yahoo_chart_aapl_1w_2026-09-24.json"),
        ("1M", "yahoo_chart_aapl_1mo_2026-09-24.json"),
    ],
)
def test_every_historical_row_but_yahoos_trailing_snapshot_starts_its_own_candle(
    timeframe, fixture
):
    rows = stamps(fixture)
    off_grid = [
        index for index, stamp in enumerate(rows) if bucket_start(stamp, timeframe) != stamp
    ]

    # Recorded mid-session: Yahoo appends one row stamped at the quote time.
    # Daily series happened to carry no such row in this capture.
    assert off_grid in ([], [len(rows) - 1])
    if timeframe != "1d":
        assert off_grid == [len(rows) - 1]


@pytest.mark.parametrize(
    ("timestamp", "timeframe", "expected"),
    [
        # Intraday anchors per session.
        ("2026-09-24T10:14:35", "1m", "2026-09-24T10:14:00"),
        ("2026-09-24T10:14:35", "5m", "2026-09-24T10:10:00"),
        ("2026-09-24T10:14:35", "15m", "2026-09-24T10:00:00"),
        ("2026-09-24T10:14:35", "1h", "2026-09-24T09:30:00"),
        ("2026-09-24T09:15:00", "1h", "2026-09-24T09:00:00"),
        ("2026-09-24T04:00:00", "1h", "2026-09-24T04:00:00"),
        ("2026-09-24T16:45:00", "1h", "2026-09-24T16:00:00"),
        ("2026-09-24T15:59:59", "1h", "2026-09-24T15:30:00"),
        # Daily: 09:30 always, including pre- and post-market timestamps.
        ("2026-09-24T05:00:00", "1d", "2026-09-24T09:30:00"),
        ("2026-09-24T18:00:00", "1d", "2026-09-24T09:30:00"),
        # Weekly: Monday 00:00, including a Labor Day Monday.
        ("2026-09-24T10:14:35", "1w", "2026-09-21T00:00:00"),
        ("2026-09-08T10:00:00", "1w", "2026-09-07T00:00:00"),
        # Monthly: the 1st at 00:00, including a weekend 1st.
        ("2026-08-14T10:00:00", "1M", "2026-08-01T00:00:00"),
        # Across the November DST change.
        ("2026-11-02T10:00:00", "1w", "2026-11-02T00:00:00"),
        ("2026-11-04T10:00:00", "1w", "2026-11-02T00:00:00"),
        ("2026-11-04T10:00:00", "1d", "2026-11-04T09:30:00"),
    ],
)
def test_bucket_start(timestamp, timeframe, expected):
    assert bucket_start(ny(timestamp), timeframe) == ny(expected)


@pytest.mark.parametrize(
    "timestamp", ["2026-09-24T03:59:00", "2026-09-24T20:00:00", "2026-09-26T10:00:00"]
)
def test_intraday_outside_every_session_has_no_candle(timestamp):
    assert bucket_start(ny(timestamp), "5m") is None


def test_unknown_timeframe_has_no_candle():
    assert bucket_start(ny("2026-09-24T10:00:00"), "2h") is None
