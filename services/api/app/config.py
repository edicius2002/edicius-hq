import os
from pathlib import Path

# Path A user-state keys (expand as features land).
ALLOWED_KV_KEYS = frozenset(
    {
        "prefs",
        "watchlist",
        "portfolio",
        "alert-rules",
        "finance",
        "greenlight",
        "drawings",
        "indicators",
        "chart-views",
        "finance-camera-views",
        "airfare-routes",
    }
)

CORS_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "CORS_ORIGINS",
        "http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]


def local_data_dir() -> Path:
    return Path(os.getenv("LOCAL_DATA_DIR", ".local-data")).resolve()


def kv_dir() -> Path:
    return local_data_dir() / "kv"


def bars_dir() -> Path:
    """Path B: a cache of public market data, never user state."""
    return local_data_dir() / "bars"


def fares_dir() -> Path:
    """
    Path B as well, but an archive rather than a cache.

    Bars can always be refetched, so `bars_dir` may be deleted at any time. A
    fare snapshot cannot: the price on a given day exists nowhere else once the
    day passes, which is the whole point of collecting them. Same data plane,
    different disposability, so a separate directory — nothing that prunes the
    cache should ever find this.
    """
    return local_data_dir() / "fares"


# How many symbols one quote request may carry. Upstream is asked per symbol,
# so this bounds the fan-out as much as the payload — see the cache note below.
MAX_BATCH_SYMBOLS = 48


class Timeframe:
    """
    One row of the timeframe table.

    `yahoo_range` is the window asked for, and the caps are not arbitrary: an
    uncapped `range=max` fetch returns decades of intraday bars and exhausts
    memory, while Yahoo simply stops serving 60m data beyond about two years.
    Both numbers were paid for by the legacy — see `js/investing/config.js`.
    """

    __slots__ = ("binance_interval", "key", "limit", "ttl", "yahoo_interval", "yahoo_range")

    def __init__(
        self,
        key: str,
        yahoo_interval: str,
        yahoo_range: str,
        binance_interval: str,
        limit: int,
        ttl: float,
    ) -> None:
        self.key = key
        self.yahoo_interval = yahoo_interval
        self.yahoo_range = yahoo_range
        self.binance_interval = binance_interval
        self.limit = limit
        self.ttl = ttl


# TTLs track how long a bar of that size stays interesting: polling faster than
# roughly a tenth of the bar period spends requests without showing anything new.
TIMEFRAMES: dict[str, Timeframe] = {
    tf.key: tf
    for tf in (
        Timeframe("1m", "1m", "7d", "1m", 1500, 10.0),
        Timeframe("5m", "5m", "60d", "5m", 1500, 20.0),
        # Yahoo documents/implements 60 days as the intraday retention edge,
        # but `range=60d` can round its start just beyond that edge and answer
        # 422. Leave one day of headroom; losing at most one session is better
        # than making this timeframe intermittently unavailable.
        Timeframe("15m", "15m", "59d", "15m", 1500, 30.0),
        Timeframe("1h", "60m", "1y", "1h", 1500, 60.0),
        Timeframe("1d", "1d", "2y", "1d", 1825, 300.0),
        Timeframe("1w", "1wk", "10y", "1w", 520, 600.0),
        Timeframe("1M", "1mo", "30y", "1M", 360, 1800.0),
    )
}

DEFAULT_TIMEFRAME = "1d"

# A quote is a price now, so it goes stale in seconds. Bars are cached far
# longer, per timeframe above.
QUOTE_TTL_SECONDS = 15.0

# Upstream is unofficial and occasionally slow; a hung request must not hold a
# page open forever.
UPSTREAM_TIMEOUT_SECONDS = 12.0

# A short provider outage must not blank a chart that was already loaded. The
# fallback is explicitly reported as stale on the wire, and one week also
# carries a Friday close across a long weekend without preserving old market
# data indefinitely.
MAX_STALE_BARS_SECONDS = 7 * 24 * 60 * 60


# --------------------------------------------------------------- airfare ----
#
# Every bound below was measured on 2026-08-18 against the live endpoint rather
# than assumed, except the request budget, which is explicitly a judgement.

# How far ahead Google will answer at all. +330 days returned 23 itineraries;
# +340, +348, +355 and +370 all answered `upstream-error`. A watched departure
# beyond this is not a slow route, it is a route that can never collect.
MAX_DEPARTURE_HORIZON_DAYS = 330

# The free daily history thins out long before the booking horizon does: 61
# points at +200 days, 52 at +280, none at all by +330. Past this, expect to
# start a series from scratch.
HISTORY_HORIZON_DAYS = 200

# Polling floor. Not a machine limit — a data one. Two snapshots 23 seconds
# apart were identical, and so were two 8 minutes apart; the first change
# appeared across 11.5 hours. Below half an hour the marginal information is
# close to zero, and 15 minutes is the point past which we would only be
# spending the one budget that matters.
MIN_POLL_MINUTES = 15

# Polling ceiling. Slower than daily puts us below the resolution of the
# history Google gives away for free, which is already one point per day.
MAX_POLL_MINUTES = 24 * 60

# How many upstream requests one day may spend. This one is a judgement, not a
# measurement: the endpoint is unmetered and the real limit is how much traffic
# this address can send before Google stops answering, which is unknown and
# deliberately unprobed — finding it costs exactly the asset it protects.
#
# 600, and it is a judgement sized against two measured numbers rather than a
# round one picked twice. The owner's present watchlist costs **442 requests a
# day** under the cadence table above — 430 boards and 12 calendar — so 300 does
# not fit it and a ceiling that is already exceeded on the day it starts being
# enforced is a ceiling nobody can turn on. And the most this address has ever
# actually sent in a day is **329**, counted from 494 heartbeat lines across
# four days, so 600 is 1.8x the busiest day on record. Between "covers what is
# watched" and "stays inside touching distance of what has already been sent
# without complaint", 600 is the smallest number that is both.
#
# It is enforced per **day** since `fare_budget`, which is what the name always
# claimed: spend is accumulated in a ledger on disk and read back at the start
# of every pass, so ninety-six passes share one 600 rather than taking one each.
DEFAULT_DAILY_REQUEST_BUDGET = 600

# The most this address has ever sent in one day, counted from 494 heartbeat
# lines across four days. A constant rather than a sentence inside the comment
# above, because it is the only number in this pair that anything measured, and
# it has a second reader now: `GET /api/fares/spend` puts it on the wire beside
# the ceiling so that a page drawing the day's spend can mark where the busiest
# real day fell. Without it a bar filling towards 600 reads as a fraction of a
# safe maximum, and nobody knows that 600 is safe — the note above says so
# outright, and a picture that quietly disagrees with its own configuration is
# worse than no picture.
BUSIEST_DAY_ON_RECORD = 329

# Cadence against how far away the departure is, as (days out, minutes between
# polls). The shape follows the measurement: at 14 days out a fare moved on 27%
# of days with a median jump of 14%, while at 150 days it moved on 22% of days
# by 1.7% — the same frequency carrying a twentieth of the news.
DEFAULT_CADENCE_MINUTES: tuple[tuple[int, int], ...] = (
    (14, 30),
    (45, 60),
    (120, 240),
    (MAX_DEPARTURE_HORIZON_DAYS, 24 * 60),
)


# How often a route's whole-horizon calendar is refreshed. One number, where
# the boards above get a table, because a calendar curve spans every distance
# from today to the horizon in one answer and so has no `days_out` to look up.
#
# Daily is the floor `MAX_POLL_MINUTES` already sets, and the measurement behind
# the table is what says it is enough: the months this covers are the far ones,
# which moved on 22% of days by a median 1.7%, while the near month the reader
# is actually watching is already collected board by board every half hour.
# Measured 2026-08-19, this costs **2.43 requests per city pair per day** against
# a budget of 600 — two windows, because the whole horizon in one request is
# refused, plus the walk-back 12.245 added when a far end is refused too. The
# 2.43 rather than 2 is why the ledger counts requests and not looks: what a
# calendar pass costs is not what it planned.
CALENDAR_POLL_MINUTES = 24 * 60

# What one city pair's calendar actually costs a day, measured rather than
# planned. Two windows are what a pass asks for; 12.245's walk-back is what it
# sometimes pays, because the provider's far edge is a calendar date that moves
# a day closer every day and a refused window is asked for again with a nearer
# end. This is the figure to cost a watchlist with — the ledger counts what was
# sent, and a plan of 2 against a bill of 2.43 is how a budget quietly slips.
CALENDAR_REQUESTS_PER_PAIR = 2.43


def daily_request_budget() -> int:
    """
    How many upstream requests a day may spend, floor of 1.

    A ceiling and not a counter: what has been spent against it lives in
    `app.services.fare_budget`, on disk, because the collector is a command a
    scheduler invokes fresh and anything held in memory here would start every
    pass at zero.
    """
    raw = os.getenv("FARES_DAILY_REQUEST_BUDGET", "").strip()
    try:
        return max(1, int(raw)) if raw else DEFAULT_DAILY_REQUEST_BUDGET
    except ValueError:
        return DEFAULT_DAILY_REQUEST_BUDGET
