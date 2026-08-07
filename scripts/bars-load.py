"""
How hard the bar endpoints can be polled, measured rather than assumed.

Decision 8.12 set the candle cadence from a request *budget* — how many calls a
day a cadence costs — not from any measurement of what upstream will actually
tolerate. That was the honest thing to do with no data. This gets the data.

It answers three questions:

  1. How much is our own cache already absorbing?
  2. At what rate does an **upstream** start refusing?
  3. What does a genuine upstream call cost?

The rate sweep goes **straight to the provider**, not through our API. The first
version of this script tried to bust our cache with a query parameter the API
ignores — so the key never changed, every request was a cache hit, and it
reported 120 requests a minute with a 32ms median while touching Yahoo perhaps
twice. Measuring the thing in front of the thing you meant to measure is the
easiest way to get a confident wrong answer.

Run it deliberately. It is **not** part of the test suite and must never be:
it hammers third-party endpoints on purpose, which is exactly what CI should
not do on every push.

    python scripts/bars-load.py --api http://127.0.0.1:8000

Stops at the first sustained refusal rather than pushing through it. The point
is to find the ceiling, not to get the address blocked.

**What this cannot tell you.** Thirty seconds at 120/min is sixty requests. A
per-minute or burst limiter would show up; a *daily quota* — which is the shape
of limit Yahoo is rumoured to apply, and the one decision 8.4 is written around
— cannot. A clean sweep here means "no burst limit found", never "poll as hard
as you like".
"""

import argparse
import json
import statistics
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field

# Two of each, so a refusal can be told apart from one bad symbol.
EQUITIES = ["AAPL", "MSFT"]
PAIRS = ["BTCUSDT", "ETHUSDT"]

# Rates to try, in requests per minute per symbol. The current cadence for a
# 5m chart is 3/min; the daily one is 0.2/min.
RATES = [3, 6, 12, 30, 60, 120]

# A rate is judged over this long. Shorter and a burst limiter never engages;
# longer and the whole run takes an afternoon.
SECONDS_PER_RATE = 30

# Enough consecutive failures to call it a refusal rather than a blip.
REFUSALS_TO_STOP = 3


@dataclass
class Result:
    rate: int
    provider: str
    ok: int = 0
    failed: int = 0
    codes: dict[str, int] = field(default_factory=dict)
    latencies: list[float] = field(default_factory=list)

    @property
    def p50(self) -> float:
        return statistics.median(self.latencies) if self.latencies else float("nan")

    @property
    def p95(self) -> float:
        if not self.latencies:
            return float("nan")
        ordered = sorted(self.latencies)
        return ordered[min(len(ordered) - 1, int(len(ordered) * 0.95))]


# Straight at the providers, because our cache is what stands between the
# cadence and them and a rate test that it answers measures nothing.
YAHOO_CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{symbol}?interval=5m&range=1d"
BINANCE_KLINES = "https://api.binance.com/api/v3/klines?symbol={symbol}&interval=5m&limit=200"

BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)


def upstream_url(provider: str, symbol: str) -> str:
    template = YAHOO_CHART if provider == "yahoo" else BINANCE_KLINES
    return template.format(symbol=symbol)


def hit_upstream(provider: str, symbol: str) -> tuple[bool, float, str]:
    request = urllib.request.Request(
        upstream_url(provider, symbol), headers={"User-Agent": BROWSER_UA}
    )
    started = time.perf_counter()
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            json.load(response)
        return True, time.perf_counter() - started, "200"
    except urllib.error.HTTPError as error:
        return False, time.perf_counter() - started, str(error.code)
    except Exception as error:  # noqa: BLE001
        return False, time.perf_counter() - started, type(error).__name__


def fetch(api: str, symbol: str, timeframe: str) -> tuple[bool, float, str]:
    """Through our API, for the cache measurement only."""
    url = f"{api}/api/market/bars?symbol={symbol}&timeframe={timeframe}"

    started = time.perf_counter()
    try:
        with urllib.request.urlopen(url, timeout=30) as response:
            json.load(response)
        return True, time.perf_counter() - started, "200"
    except urllib.error.HTTPError as error:
        return False, time.perf_counter() - started, str(error.code)
    except Exception as error:  # noqa: BLE001 — any failure is a failure
        return False, time.perf_counter() - started, type(error).__name__


def cache_effect(api: str, timeframe: str) -> None:
    """What the server's own cache is already absorbing."""
    print("\n== the cache in front of it ==")
    for symbol in (EQUITIES[0], PAIRS[0]):
        # Cold is measured at the provider, because that is what a cache miss
        # actually costs us — asking our own API again would just hit the cache.
        cold = hit_upstream("yahoo" if symbol in EQUITIES else "binance", symbol)
        warm = [fetch(api, symbol, timeframe)[1] for _ in range(5)]
        print(
            f"  {symbol:8} cold {cold[1] * 1000:7.0f} ms   "
            f"warm {statistics.median(warm) * 1000:6.1f} ms   "
            f"absorbed {(1 - statistics.median(warm) / cold[1]) * 100:4.1f}%"
        )


def run_rate(api: str, symbols: list[str], provider: str, timeframe: str, rate: int) -> Result:
    del api, timeframe
    result = Result(rate=rate, provider=provider)
    interval = 60 / rate
    deadline = time.time() + SECONDS_PER_RATE
    consecutive = 0
    index = 0

    while time.time() < deadline:
        symbol = symbols[index % len(symbols)]
        index += 1

        ok, seconds, code = hit_upstream(provider, symbol)
        result.latencies.append(seconds)
        result.codes[code] = result.codes.get(code, 0) + 1

        if ok:
            result.ok += 1
            consecutive = 0
        else:
            result.failed += 1
            consecutive += 1
            if consecutive >= REFUSALS_TO_STOP:
                print(f"     refused {consecutive}x in a row — stopping here")
                break

        time.sleep(max(0.0, interval - seconds))

    return result


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--api", default="http://127.0.0.1:8000")
    parser.add_argument("--timeframe", default="5m")
    args = parser.parse_args()

    print(f"api {args.api}   timeframe {args.timeframe}   {SECONDS_PER_RATE}s per rate")
    cache_effect(args.api, args.timeframe)

    for provider, symbols in (("yahoo", EQUITIES), ("binance", PAIRS)):
        print(f"\n== {provider} ==")
        print("  rate/min      ok  failed    p50      p95   codes")
        for rate in RATES:
            result = run_rate(args.api, symbols, provider, args.timeframe, rate)
            codes = " ".join(f"{k}:{v}" for k, v in sorted(result.codes.items()))
            print(
                f"  {rate:>8}  {result.ok:>6}  {result.failed:>6}  "
                f"{result.p50 * 1000:6.0f}ms  {result.p95 * 1000:6.0f}ms   {codes}"
            )
            if result.failed >= REFUSALS_TO_STOP:
                print(f"     ceiling for {provider} is below {rate}/min")
                break


if __name__ == "__main__":
    main()
