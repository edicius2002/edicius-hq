"""Build Yahoo's authoritative provisional candle from short chart series."""

from __future__ import annotations

import time
from collections.abc import Sequence
from datetime import date, datetime, timedelta
from datetime import time as clock_time

import httpx

from app.adapters import yahoo
from app.adapters.models import CLOSED, REGULAR, Bar, BarFocus, LiveBar
from app.adapters.yahoo_buckets import (
    INTRADAY_MINUTES,
    NEW_YORK,
    bucket_start,
    local_datetime,
    session_at,
)

# Kept under the names `live_bars` already imports; the definitions live in
# `yahoo_buckets` so the live candle and the history agree on every anchor.
yahoo_session_at = session_at


def local_date(timestamp: int | float) -> date:
    return local_datetime(timestamp).date()


def seconds_until_yahoo_open(timestamp: int | float) -> float:
    """Return seconds until the next weekday 04:00 New York open."""
    local = local_datetime(timestamp)
    candidate = local.date()
    if local.weekday() >= 5 or local.hour >= 4:
        candidate += timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    opening = datetime.combine(candidate, clock_time(4, 0), tzinfo=NEW_YORK)
    return max(0.0, opening.timestamp() - timestamp)


def _bucket(timestamp: int | float, timeframe: str) -> int:
    """
    `bucket_start` for a timestamp already known to have a candle.

    Every caller here passes an eligible minute (inside a session) or a
    daily-or-longer timeframe, neither of which can come back None.
    """
    start = bucket_start(timestamp, timeframe)
    if start is None:
        raise ValueError(f"no Yahoo {timeframe} candle contains {timestamp}")
    return start


def combine(time: int, bars: Sequence[Bar]) -> Bar | None:
    if not bars:
        return None
    ordered = sorted(bars, key=lambda bar: bar.time)
    return Bar(
        time=time,
        open=ordered[0].open,
        high=max(bar.high for bar in ordered),
        low=min(bar.low for bar in ordered),
        close=ordered[-1].close,
        volume=sum(bar.volume for bar in ordered),
    )


def _eligible_minutes(focus: BarFocus, minute_bars: Sequence[Bar], as_of: float) -> list[Bar]:
    eligible: list[Bar] = []
    for bar in minute_bars:
        if bar.time > as_of:
            continue
        session = yahoo_session_at(bar.time)
        if session == CLOSED or (not focus.extended and session != REGULAR):
            continue
        eligible.append(bar)
    return eligible


def _current_day_minutes(focus: BarFocus, minute_bars: Sequence[Bar], as_of: float) -> list[Bar]:
    today = local_date(as_of)
    return [
        bar for bar in _eligible_minutes(focus, minute_bars, as_of) if local_date(bar.time) == today
    ]


def aggregate_live_bar(
    focus: BarFocus,
    minute_bars: Sequence[Bar],
    daily_bars: Sequence[Bar],
    as_of: float,
) -> LiveBar | None:
    """Aggregate the latest provider rows for one focused Yahoo candle."""
    eligible = _eligible_minutes(focus, minute_bars, as_of)
    if not eligible:
        return None

    if focus.timeframe in INTRADAY_MINUTES:
        # Yahoo's trailing quote snapshot is stamped mid-minute (10:19:02);
        # bucketing by start folds it into its minute like any other row.
        latest = max(eligible, key=lambda bar: bar.time)
        bucket = _bucket(latest.time, focus.timeframe)
        selected = [bar for bar in eligible if _bucket(bar.time, focus.timeframe) == bucket]
        current = combine(bucket, selected)
    else:
        today = local_date(as_of)
        selected_minutes = _current_day_minutes(focus, minute_bars, as_of)
        current_day = combine(_bucket(as_of, "1d"), selected_minutes)
        if focus.timeframe == "1d":
            completed: list[Bar] = []
        else:
            completed = [bar for bar in daily_bars if local_date(bar.time) < today]
            if focus.timeframe == "1w":
                year_week = today.isocalendar()[:2]
                completed = [
                    bar for bar in completed if local_date(bar.time).isocalendar()[:2] == year_week
                ]
            elif focus.timeframe == "1M":
                completed = [
                    bar
                    for bar in completed
                    if (local_date(bar.time).year, local_date(bar.time).month)
                    == (today.year, today.month)
                ]
            else:
                return None
        pieces = [*completed, *([] if current_day is None else [current_day])]
        # Stamped where Yahoo's own history stamps the period — 09:30 for a
        # day even with pre-market minutes inside it, 00:00 Monday for a
        # week, 00:00 on the 1st for a month — never at the earliest piece,
        # or the browser cannot match it to the historical candle it updates.
        current = combine(_bucket(as_of, focus.timeframe), pieces)

    if current is None:
        return None
    return LiveBar(
        symbol=focus.symbol,
        timeframe=focus.timeframe,
        extended=focus.extended,
        as_of=float(as_of),
        bar=current,
        provider=yahoo.PROVIDER,
    )


class YahooLiveBarClient:
    """Bounded Yahoo chart fetches plus an expiring completed-day prefix cache."""

    def __init__(self, client: httpx.AsyncClient, *, clock=time.monotonic) -> None:
        self._client = client
        self._clock = clock
        self._daily: dict[str, tuple[float, list[Bar]]] = {}

    async def _daily_prefix(self, symbol: str) -> list[Bar]:
        now = self._clock()
        cached = self._daily.get(symbol)
        if cached is not None and now - cached[0] < 60:
            return cached[1]
        bars, _ = await yahoo.fetch_chart_bars(
            self._client, symbol, interval="1d", range_="3mo", extended=True
        )
        self._daily[symbol] = (now, bars)
        return bars

    async def fetch(self, focus: BarFocus) -> LiveBar | None:
        minutes, as_of = await yahoo.fetch_chart_bars(
            self._client, focus.symbol, interval="1m", range_="1d", extended=True
        )
        if not minutes:
            return None
        daily: list[Bar] = []
        if focus.timeframe in {"1w", "1M"}:
            daily = await self._daily_prefix(focus.symbol)
        return aggregate_live_bar(focus, minutes, daily, as_of)
