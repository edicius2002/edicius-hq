"""
Binance, for crypto.

Unlike Yahoo this is an official, documented, keyless API with published rate
limits, so it needs none of the defensive handling next door. It is used for
pairs rather than because the legacy used it — see plan decision 8.1.
"""

from typing import Any

import httpx

from app.adapters.models import Bar, ProviderError, Quote
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
    )


async def fetch_bars(client: httpx.AsyncClient, symbol: str, timeframe: Timeframe) -> list[Bar]:
    payload = await _get_json(
        client,
        "/api/v3/klines",
        {"symbol": symbol, "interval": timeframe.binance_interval, "limit": timeframe.limit},
    )
    return parse_bars(payload)


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
