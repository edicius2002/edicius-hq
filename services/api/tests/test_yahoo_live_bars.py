import asyncio
import json
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import httpx
import pytest

from app.adapters import yahoo
from app.adapters.models import Bar, BarFocus
from app.adapters.yahoo_buckets import bucket_start
from app.adapters.yahoo_live_bars import YahooLiveBarClient, aggregate_live_bar

NY = ZoneInfo("America/New_York")
FIXTURES = Path(__file__).parent / "fixtures"
AS_OF = datetime(2026, 9, 22, 10, 0, tzinfo=NY).timestamp()


def ny_timestamp(value: str) -> int:
    return int(datetime.fromisoformat(value).replace(tzinfo=NY).timestamp())


def minute_fixture() -> list[Bar]:
    return [
        Bar(ny_timestamp("2026-09-22T09:29:00"), 98, 99, 97, 98, 10),
        Bar(ny_timestamp("2026-09-22T09:30:00"), 100, 102, 99, 101, 30),
        Bar(ny_timestamp("2026-09-22T09:59:00"), 101, 104, 100, 103, 30),
        Bar(ny_timestamp("2026-09-22T10:29:00"), 104, 105, 102, 104, 40),
    ]


def test_regular_hour_is_anchored_at_0930_and_excludes_premarket():
    focus = BarFocus("AAPL", "1h", False)
    update = aggregate_live_bar(focus, minute_fixture(), [], AS_OF)

    assert update.bar.time == ny_timestamp("2026-09-22T09:30:00")
    assert update.bar.open == 100
    assert update.bar.high == 104
    assert update.bar.low == 99
    assert update.bar.close == 103
    assert update.bar.volume == 60


@pytest.mark.parametrize("timeframe", ["1m", "5m", "15m", "1h"])
def test_regular_intraday_timeframes_share_the_session_anchor(timeframe: str):
    update = aggregate_live_bar(
        BarFocus("AAPL", timeframe, False),
        minute_fixture(),
        [],
        ny_timestamp("2026-09-22T09:30:00"),
    )

    assert update is not None
    assert update.bar.time == ny_timestamp("2026-09-22T09:30:00")


def test_dst_regular_session_keeps_0930_local_anchor():
    as_of = datetime(2026, 11, 2, 9, 30, tzinfo=NY).timestamp()
    minutes = [
        Bar(ny_timestamp("2026-11-02T09:29:00"), 98, 99, 97, 98, 10),
        Bar(ny_timestamp("2026-11-02T09:30:00"), 100, 102, 99, 101, 30),
        Bar(ny_timestamp("2026-11-02T09:59:00"), 101, 104, 100, 103, 30),
    ]

    update = aggregate_live_bar(BarFocus("AAPL", "1h", False), minutes, [], as_of)

    assert update is not None
    assert update.bar.time == ny_timestamp("2026-11-02T09:30:00")


def test_extended_daily_bar_includes_pre_regular_and_post_minutes():
    minutes = [
        Bar(ny_timestamp("2026-09-22T04:00:00"), 98, 99, 97, 98, 10),
        Bar(ny_timestamp("2026-09-22T09:30:00"), 100, 102, 99, 101, 20),
        Bar(ny_timestamp("2026-09-22T10:00:00"), 101, 104, 100, 103, 30),
        Bar(ny_timestamp("2026-09-22T16:00:00"), 104, 105, 102, 104, 40),
        Bar(ny_timestamp("2026-09-22T16:59:00"), 104, 106, 103, 105, 75),
    ]

    update = aggregate_live_bar(
        BarFocus("AAPL", "1d", True), minutes, [], ny_timestamp("2026-09-22T17:00:00")
    )

    assert update is not None
    # Stamped 09:30 like Yahoo's daily history, even though the content
    # starts with the 04:00 pre-market minute.
    assert update.bar == Bar(
        time=ny_timestamp("2026-09-22T09:30:00"), open=98, high=106, low=97, close=105, volume=175
    )


def test_week_uses_completed_days_plus_today_minutes_without_double_counting():
    today_minutes = [
        Bar(ny_timestamp("2026-09-22T09:30:00"), 100, 101, 99, 100, 75),
    ]
    completed_days = [
        Bar(ny_timestamp("2026-09-21T09:30:00"), 90, 110, 80, 100, 1200),
        Bar(ny_timestamp("2026-09-22T00:00:00"), 1, 1, 1, 1, 999),
    ]

    update = aggregate_live_bar(
        BarFocus("AAPL", "1w", True),
        today_minutes,
        completed_days,
        ny_timestamp("2026-09-22T10:00:00"),
    )

    assert update is not None
    assert update.bar.volume == 1_275
    # Monday 00:00, where Yahoo's weekly history puts it — not the time of the
    # earliest daily piece (Monday 09:30).
    assert update.bar.time == ny_timestamp("2026-09-21T00:00:00")


@pytest.mark.parametrize("extended", [False, True])
def test_week_and_month_buckets_do_not_depend_on_extended_or_pieces(extended: bool):
    minutes = [Bar(ny_timestamp("2026-09-22T10:00:00"), 100, 101, 99, 100, 5)]
    as_of = ny_timestamp("2026-09-22T10:00:00")

    week = aggregate_live_bar(BarFocus("AAPL", "1w", extended), minutes, [], as_of)
    month = aggregate_live_bar(BarFocus("AAPL", "1M", extended), minutes, [], as_of)

    assert week is not None and month is not None
    assert week.bar.time == ny_timestamp("2026-09-21T00:00:00")
    assert month.bar.time == ny_timestamp("2026-09-01T00:00:00")


def test_month_excludes_a_prior_month_daily_bar():
    update = aggregate_live_bar(
        BarFocus("AAPL", "1M", True),
        [Bar(ny_timestamp("2026-09-22T09:30:00"), 100, 101, 99, 100, 75)],
        [
            Bar(ny_timestamp("2026-08-31T09:30:00"), 1, 1000, 1, 1000, 10000),
            Bar(ny_timestamp("2026-09-21T09:30:00"), 90, 110, 80, 100, 1200),
        ],
        ny_timestamp("2026-09-22T10:00:00"),
    )

    assert update is not None
    assert update.bar.volume == 1_275


def test_month_end_fetch_includes_the_first_calendar_day_of_the_month():
    requests: list[httpx.Request] = []
    first_day = ny_timestamp("2026-09-01T09:30:00")
    last_day = ny_timestamp("2026-09-30T09:30:00")

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.params["interval"] == "1m":
            row = (last_day, 30, 35, 29, 34, 50)
        else:
            row = (first_day, 10, 20, 9, 18, 100)
        return httpx.Response(
            200,
            json=yahoo_chart(
                stamps=[row[0]],
                opens=[row[1]],
                highs=[row[2]],
                lows=[row[3]],
                closes=[row[4]],
                volumes=[row[5]],
            ),
        )

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await YahooLiveBarClient(client).fetch(BarFocus("AAPL", "1M", True))

    update = asyncio.run(run())

    assert update is not None
    # Yahoo stamps a monthly candle 00:00 on the 1st, not at the session open.
    assert update.bar == Bar(ny_timestamp("2026-09-01T00:00:00"), 10, 35, 9, 34, 150)
    assert requests[1].url.params["range"] == "3mo"


def test_provider_volume_correction_can_reduce_the_authoritative_bar():
    focus = BarFocus("AAPL", "1m", False)
    before = aggregate_live_bar(
        focus,
        [Bar(ny_timestamp("2026-09-22T09:30:00"), 100, 101, 99, 100, 100)],
        [],
        ny_timestamp("2026-09-22T09:30:00"),
    )
    after = aggregate_live_bar(
        focus,
        [Bar(ny_timestamp("2026-09-22T09:30:00"), 100, 101, 99, 100, 80)],
        [],
        ny_timestamp("2026-09-22T09:30:05"),
    )

    assert before is not None and after is not None
    assert after.bar.volume == 80 < before.bar.volume


def test_zero_volume_keeps_the_current_bar_present():
    update = aggregate_live_bar(
        BarFocus("AAPL", "1m", False),
        [Bar(ny_timestamp("2026-09-22T09:30:00"), 100, 101, 99, 100, 0)],
        [],
        ny_timestamp("2026-09-22T09:30:00"),
    )

    assert update is not None
    assert update.bar.volume == 0


def yahoo_chart(*, stamps, opens, highs, lows, closes, volumes):
    return {
        "chart": {
            "error": None,
            "result": [
                {
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


def test_live_parser_rejects_missing_or_non_finite_volume_but_keeps_zero():
    payload = yahoo_chart(
        stamps=[1, 2, 3, 4],
        opens=[10, 10, 10, 10],
        highs=[11, 11, 11, 11],
        lows=[9, 9, 9, 9],
        closes=[10, 10, 10, 10],
        volumes=[0, None, "nan", "bad"],
    )

    bars = yahoo.parse_live_bars(payload)

    assert bars == [Bar(1, 10, 11, 9, 10, 0)]


@pytest.mark.parametrize("quote", [None, "malformed"])
def test_live_parser_ignores_malformed_quote_container(quote):
    payload = yahoo_chart(stamps=[1], opens=[10], highs=[11], lows=[9], closes=[10], volumes=[1])
    payload["chart"]["result"][0]["indicators"]["quote"] = [quote]

    assert yahoo.parse_live_bars(payload) == []


def test_live_parser_ignores_overflowing_numeric_values():
    payload = yahoo_chart(
        stamps=[1], opens=[10**10000], highs=[11], lows=[9], closes=[10], volumes=[1]
    )

    assert yahoo.parse_live_bars(payload) == []


def test_fetch_chart_bars_uses_bounded_extended_request_and_provider_watermark():
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(
            200,
            json=yahoo_chart(
                stamps=[10, 20],
                opens=[10, 11],
                highs=[11, 12],
                lows=[9, 10],
                closes=[10, 11],
                volumes=[1, 2],
            ),
        )

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await yahoo.fetch_chart_bars(
                client, "AAPL", interval="1m", range_="1d", extended=True
            )

    bars, as_of = asyncio.run(run())

    assert len(requests) == 1
    assert requests[0].url.params["interval"] == "1m"
    assert requests[0].url.params["range"] == "1d"
    assert requests[0].url.params["includePrePost"] == "true"
    assert [bar.time for bar in bars] == [10, 20]
    assert as_of == 20


def test_empty_minute_series_produces_no_live_update():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200, json=yahoo_chart(stamps=[], opens=[], highs=[], lows=[], closes=[], volumes=[])
        )

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await YahooLiveBarClient(client).fetch(BarFocus("AAPL", "1d", True))

    assert asyncio.run(run()) is None


def test_weekly_daily_prefix_is_bounded_cached_and_expires():
    now = [100.0]
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.params["interval"] == "1m":
            body = yahoo_chart(
                stamps=[ny_timestamp("2026-09-22T09:30:00")],
                opens=[100],
                highs=[101],
                lows=[99],
                closes=[100],
                volumes=[1],
            )
        else:
            body = yahoo_chart(
                stamps=[ny_timestamp("2026-09-21T09:30:00")],
                opens=[90],
                highs=[100],
                lows=[80],
                closes=[95],
                volumes=[10],
            )
        return httpx.Response(200, json=body)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            adapter = YahooLiveBarClient(client, clock=lambda: now[0])
            focus = BarFocus("AAPL", "1w", True)
            first = await adapter.fetch(focus)
            now[0] += 30
            second = await adapter.fetch(focus)
            now[0] += 30
            third = await adapter.fetch(focus)
            return first, second, third

    first, second, third = asyncio.run(run())

    assert first is not None and second is not None and third is not None
    assert [
        (request.url.params["interval"], request.url.params["range"]) for request in requests
    ] == [
        ("1m", "1d"),
        ("1d", "3mo"),
        ("1m", "1d"),
        ("1m", "1d"),
        ("1d", "3mo"),
    ]


def load_fixture(name: str) -> list[Bar]:
    path = FIXTURES / f"yahoo_chart_aapl_{name}_2026-09-24.json"
    return yahoo.parse_live_bars(json.loads(path.read_text(encoding="utf-8")))


# The historical series a live candle has to land on, per timeframe and focus.
# There is no extended capture for 1m/5m/15m; during the regular session an
# extended series carries the same tail, so the regular one stands in.
HISTORY_FIXTURES = {
    ("1m", False): "1m",
    ("1m", True): "1m",
    ("5m", False): "5m",
    ("5m", True): "5m",
    ("15m", False): "15m",
    ("15m", True): "15m",
    ("1h", False): "1h",
    ("1h", True): "1h_ext",
    ("1d", False): "1d",
    ("1d", True): "1d_ext",
    ("1w", False): "1w",
    ("1w", True): "1w",
    ("1M", False): "1mo",
    ("1M", True): "1mo",
}
LIVE_EXPECTED = {
    "1m": "2026-09-24T10:19:00",
    "5m": "2026-09-24T10:15:00",
    "15m": "2026-09-24T10:15:00",
    "1h": "2026-09-24T09:30:00",
    "1d": "2026-09-24T09:30:00",
    "1w": "2026-09-21T00:00:00",
    "1M": "2026-09-01T00:00:00",
}


@pytest.mark.parametrize(("timeframe", "extended"), sorted(HISTORY_FIXTURES))
def test_live_candle_lands_on_yahoo_history_tail(timeframe: str, extended: bool):
    """
    Real capture, AAPL 2026-09-24 ~10:19 NY: the live candle must carry the
    time of the history's last candle, or the browser cannot merge it.

    The history's last row is Yahoo's off-grid quote snapshot (intraday) or
    today's daily row (1w/1M); normalised, it folds into `bucket_start` of
    itself, which is therefore the last candle's time.
    """
    minutes = load_fixture("live1m")
    daily = load_fixture("1d_ext")
    as_of = float(max(bar.time for bar in minutes))
    history = load_fixture(HISTORY_FIXTURES[(timeframe, extended)])

    update = aggregate_live_bar(BarFocus("AAPL", timeframe, extended), minutes, daily, as_of)

    assert update is not None
    assert update.bar.time == bucket_start(history[-1].time, timeframe)
    assert update.bar.time == ny_timestamp(LIVE_EXPECTED[timeframe])


def test_trailing_quote_snapshot_folds_into_its_minute_without_adding_volume():
    minutes = load_fixture("live1m")
    snapshot = minutes[-1]
    as_of = float(snapshot.time)
    # Yahoo's trailing row: stamped at the quote time, flat, volume 0.
    assert snapshot.time % 60 != 0 and snapshot.volume == 0
    assert snapshot.open == snapshot.high == snapshot.low == snapshot.close

    one = aggregate_live_bar(BarFocus("AAPL", "1m", False), minutes, [], as_of)
    five = aggregate_live_bar(BarFocus("AAPL", "5m", False), minutes, [], as_of)

    assert one is not None and five is not None
    assert one.bar == Bar(
        ny_timestamp("2026-09-24T10:19:00"),
        snapshot.open,
        snapshot.high,
        snapshot.low,
        snapshot.close,
        0,
    )
    real = [
        bar
        for bar in minutes
        if ny_timestamp("2026-09-24T10:15:00") <= bar.time < ny_timestamp("2026-09-24T10:19:00")
    ]
    assert len(real) == 4
    assert five.bar.time == ny_timestamp("2026-09-24T10:15:00")
    assert five.bar.open == real[0].open
    assert five.bar.volume == sum(bar.volume for bar in real)
    assert five.bar.close == snapshot.close
