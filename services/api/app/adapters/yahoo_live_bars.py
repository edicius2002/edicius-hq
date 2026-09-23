"""Build Yahoo's authoritative provisional candle from short chart series."""

from __future__ import annotations

import time
from collections.abc import Sequence
from datetime import date, datetime, timedelta
from datetime import time as clock_time
from zoneinfo import ZoneInfo

import httpx

from app.adapters import yahoo
from app.adapters.models import CLOSED, POST, PRE, REGULAR, Bar, BarFocus, LiveBar

NEW_YORK = ZoneInfo("America/New_York")
_SESSION_ANCHORS = {PRE: (4, 0), REGULAR: (9, 30), POST: (16, 0)}
_INTRADAY_PERIODS = {"1m": 1, "5m": 5, "15m": 15, "1h": 60}


def local_datetime(timestamp: int | float) -> datetime:
    return datetime.fromtimestamp(timestamp, tz=NEW_YORK)


def local_date(timestamp: int | float) -> date:
    return local_datetime(timestamp).date()


def yahoo_session_at(timestamp: int) -> str:
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


def intraday_bucket_start(timestamp: int, timeframe: str, session: str) -> int:
    """Use 04:00, 09:30, or 16:00 New York anchors."""
    period = _INTRADAY_PERIODS[timeframe]
    hour, minute = _SESSION_ANCHORS[session]
    local = local_datetime(timestamp)
    elapsed = local.hour * 60 + local.minute - (hour * 60 + minute)
    bucket_minutes = hour * 60 + minute + (elapsed // period) * period
    bucket = datetime.combine(local.date(), clock_time.min, tzinfo=NEW_YORK) + timedelta(
        minutes=bucket_minutes
    )
    return int(bucket.timestamp())


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


def _day_bucket_start(as_of: float, extended: bool) -> int:
    local = local_datetime(as_of)
    hour, minute = _SESSION_ANCHORS[PRE if extended else REGULAR]
    bucket = datetime.combine(local.date(), clock_time(hour, minute), tzinfo=NEW_YORK)
    return int(bucket.timestamp())


def _period_bucket_start(as_of: float, timeframe: str, extended: bool) -> int:
    local = local_datetime(as_of)
    if timeframe == "1d":
        return _day_bucket_start(as_of, extended)
    if timeframe == "1w":
        start = local.date() - timedelta(days=local.date().weekday())
    else:
        start = local.date().replace(day=1)
    hour, minute = _SESSION_ANCHORS[PRE if extended else REGULAR]
    return int(datetime.combine(start, clock_time(hour, minute), tzinfo=NEW_YORK).timestamp())


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

    if focus.timeframe in _INTRADAY_PERIODS:
        latest = max(eligible, key=lambda bar: bar.time)
        session = yahoo_session_at(latest.time)
        bucket = intraday_bucket_start(latest.time, focus.timeframe, session)
        selected = [
            bar
            for bar in eligible
            if yahoo_session_at(bar.time) == session
            and intraday_bucket_start(bar.time, focus.timeframe, session) == bucket
        ]
        current = combine(bucket, selected)
    else:
        today = local_date(as_of)
        selected_minutes = _current_day_minutes(focus, minute_bars, as_of)
        current_day = combine(_day_bucket_start(as_of, focus.extended), selected_minutes)
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
        if focus.timeframe == "1d":
            bucket = _day_bucket_start(as_of, focus.extended)
        elif pieces:
            bucket = min(piece.time for piece in pieces)
        else:
            bucket = _period_bucket_start(as_of, focus.timeframe, focus.extended)
        current = combine(bucket, pieces)

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
