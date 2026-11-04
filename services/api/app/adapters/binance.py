"""
Binance, for crypto.

Unlike Yahoo this is an official, documented, keyless API with published rate
limits, so it needs none of the defensive handling next door. It is used for
pairs rather than because the legacy used it — see plan decision 8.1.
"""

from typing import Any

import httpx

from app.adapters.models import Bar, ProviderError, Quote, SymbolHit
from app.config import Timeframe

PROVIDER = "binance"

HOST = "https://api.binance.com"

# Every pair here quotes against USDT, which is what the price is denominated in.
QUOTE_CURRENCY = "USDT"


async def _get_json(client: httpx.AsyncClient, path: str, params: dict[str, Any]) -> Any:
    try:
        response = await client.get(f"{HOST}{path}", params=params)
    except httpx.HTTPError as exc:
        raise ProviderError("unreachable", f"Binance could not be reached: {exc}") from exc

    if response.status_code == 400:
        # Binance answers 400, not 404, for a pair it does not list.
        raise ProviderError("symbol-not-found", "Binance does not list that pair")
    if response.status_code == 429:
        raise ProviderError("rate-limited", "Binance is rate limiting this address")
    if response.status_code >= 400:
        raise ProviderError("upstream-error", f"Binance answered {response.status_code}")

    try:
        return response.json()
    except ValueError as exc:
        raise ProviderError("upstream-error", f"Binance sent something unreadable: {exc}") from exc


async def fetch_quote(client: httpx.AsyncClient, symbol: str) -> Quote:
    payload = await _get_json(client, "/api/v3/ticker/24hr", {"symbol": symbol})
    return parse_quote(symbol, payload)


async def search_pair(client: httpx.AsyncClient, symbol: str) -> SymbolHit | None:
    """Validate a fully typed pair against Binance's listed Spot instruments."""
    try:
        payload = await _get_json(client, "/api/v3/exchangeInfo", {"symbol": symbol})
    except ProviderError as error:
        if error.code == "symbol-not-found":
            return None
        raise
    rows = payload.get("symbols") if isinstance(payload, dict) else None
    if not isinstance(rows, list):
        raise ProviderError("upstream-error", "Binance sent invalid exchange information")
    for row in rows:
        if (
            isinstance(row, dict)
            and row.get("symbol") == symbol
            and row.get("status") == "TRADING"
            and row.get("isSpotTradingAllowed") is True
        ):
            base = row.get("baseAsset")
            quote = row.get("quoteAsset")
            if isinstance(base, str) and isinstance(quote, str):
                return SymbolHit(symbol, f"{base}/{quote}", "crypto", "Binance")
    return None


def parse_quote(symbol: str, payload: Any) -> Quote:
    price = (payload or {}).get("lastPrice")
    if price is None:
        raise ProviderError("no-price", "Binance returned no price", symbol=symbol)

    last = float(price)
    change = payload.get("priceChange")
    # Binance reports the change over 24h rather than a previous close, so the
    # close is derived from it — the same number the other way round.
    previous = last - float(change) if change is not None else None

    return Quote(
        symbol=symbol,
        price=last,
        currency=QUOTE_CURRENCY,
        previous_close=previous,
        provider=PROVIDER,
        # Binance stamps the close of its rolling ticker window in milliseconds;
        # its ticks and our public contract use Unix seconds.
        time=_timestamp_seconds(payload.get("closeTime")),
    )


def _timestamp_seconds(value: object) -> float | None:
    # `except TypeError` was the guard against a payload that hands back a list
    # or a dict here, but a type checker cannot read a guard written that way —
    # it only sees `float(object)`. Narrowing first says the same thing where
    # mypy can see it, and `None` still falls straight through.
    if not isinstance(value, int | float | str):
        return None
    try:
        return float(value) / 1000
    except ValueError:
        return None


async def fetch_bars(client: httpx.AsyncClient, symbol: str, timeframe: Timeframe) -> list[Bar]:
    wanted = timeframe.limit
    latest_limit = min(wanted, 1000)
    payload = await _get_json(
        client,
        "/api/v3/klines",
        {
            "symbol": symbol,
            "interval": timeframe.binance_interval,
            "limit": latest_limit,
        },
    )
    bars = parse_bars(payload)
    while len(bars) >= latest_limit and len(bars) < wanted:
        remaining = min(wanted - len(bars), 1000)
        older_payload = await _get_json(
            client,
            "/api/v3/klines",
            {
                "symbol": symbol,
                "interval": timeframe.binance_interval,
                "limit": remaining,
                "endTime": bars[0].time * 1000 - 1,
            },
        )
        older = [bar for bar in parse_bars(older_payload) if bar.time < bars[0].time]
        if not older:
            break
        bars = older + bars
        latest_limit = remaining
    return bars[-wanted:]


def parse_bars(payload: Any) -> list[Bar]:
    """A kline is a positional array; the first six entries are what a candle is."""
    if not isinstance(payload, list):
        raise ProviderError("upstream-error", "Binance sent something that is not a series")

    bars: list[Bar] = []
    for row in payload:
        if not isinstance(row, list) or len(row) < 6:
            continue
        try:
            bars.append(
                Bar(
                    # Binance stamps in milliseconds; everything here is seconds.
                    time=int(row[0]) // 1000,
                    open=float(row[1]),
                    high=float(row[2]),
                    low=float(row[3]),
                    close=float(row[4]),
                    volume=float(row[5]),
                )
            )
        except (TypeError, ValueError):
            continue
    return bars
