"""
Where each Yahoo candle starts, in the timestamps Yahoo's own history uses.

A live candle only replaces the historical one when both carry the same
`time`, so this is the single place that decides it. Measured against Yahoo's
chart API on 2026-09-24 (fixtures `yahoo_chart_aapl_*_2026-09-24.json`):

- Intraday candles start at a session anchor — 04:00 pre-market, 09:30
  regular, 16:00 post-market — plus whole periods. An extended `1h` series
  therefore has a 09:00 candle, then 09:30.
- A daily candle starts at 09:30 on its trading date, whether or not pre- and
  post-market were requested.
- A weekly candle starts at 00:00 on the Monday of its week, and a monthly one
  at 00:00 on the first of its month, even when that day is a holiday or a
  weekend.

All in America/New_York, so DST is handled by the zone rather than an offset.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from datetime import time as clock_time
from zoneinfo import ZoneInfo

from app.adapters.models import CLOSED, POST, PRE, REGULAR

NEW_YORK = ZoneInfo("America/New_York")
SESSION_ANCHORS = {PRE: (4, 0), REGULAR: (9, 30), POST: (16, 0)}
INTRADAY_MINUTES = {"1m": 1, "5m": 5, "15m": 15, "1h": 60}
TIMEFRAMES = frozenset({*INTRADAY_MINUTES, "1d", "1w", "1M"})


def local_datetime(timestamp: int | float) -> datetime:
    return datetime.fromtimestamp(timestamp, tz=NEW_YORK)


def session_at(timestamp: int | float) -> str:
    """Return PRE, REGULAR, POST, or CLOSED in America/New_York."""
    local = local_datetime(timestamp)
    if local.weekday() >= 5:
        return CLOSED
    minutes = local.hour * 60 + local.minute
    if 4 * 60 <= minutes < 9 * 60 + 30:
        return PRE
    if 9 * 60 + 30 <= minutes < 16 * 60:
        return REGULAR
    if 16 * 60 <= minutes < 20 * 60:
        return POST
    return CLOSED


def _at(day, hour: int, minute: int) -> int:
    return int(datetime.combine(day, clock_time(hour, minute), tzinfo=NEW_YORK).timestamp())


def bucket_start(timestamp: int | float, timeframe: str) -> int | None:
    """
    The start of the Yahoo candle containing `timestamp`.

    None when there is no such candle: an unknown timeframe, or an intraday
    timestamp outside every session.
    """
    if timeframe not in TIMEFRAMES:
        return None
    local = local_datetime(timestamp)
    day = local.date()

    if timeframe in INTRADAY_MINUTES:
        session = session_at(timestamp)
        if session == CLOSED:
            return None
        hour, minute = SESSION_ANCHORS[session]
        period = INTRADAY_MINUTES[timeframe]
        elapsed = local.hour * 60 + local.minute - (hour * 60 + minute)
        start = datetime.combine(day, clock_time(hour, minute), tzinfo=NEW_YORK)
        return int((start + timedelta(minutes=(elapsed // period) * period)).timestamp())
    if timeframe == "1d":
        return _at(day, 9, 30)
    if timeframe == "1w":
        return _at(day - timedelta(days=day.weekday()), 0, 0)
    return _at(day.replace(day=1), 0, 0)


__all__ = [
    "INTRADAY_MINUTES",
    "NEW_YORK",
    "SESSION_ANCHORS",
    "TIMEFRAMES",
    "bucket_start",
    "local_datetime",
    "session_at",
]
