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
