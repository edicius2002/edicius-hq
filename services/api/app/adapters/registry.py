"""
Which provider serves a symbol.

This decision lives here and only here: a caller asks for `BTCUSDT` or `AAPL`
and gets bars, without learning who answered — plan decision 8.3. Adding a
provider is a case in `provider_for` plus a module beside this one.
"""

import httpx

from app.adapters import binance, yahoo
from app.adapters.models import Bar, ProviderError, Quote, SymbolHit
from app.config import Timeframe

# Binance quotes its pairs against these. A symbol ending in one is a pair,
# which is a firmer signal than a list of coins that goes stale.
_CRYPTO_QUOTE_ASSETS = ("USDT", "USDC", "BUSD", "FDUSD")


def normalize_symbol(symbol: str) -> str:
    return symbol.strip().upper()


def provider_for(symbol: str) -> str:
    symbol = normalize_symbol(symbol)
    if any(symbol.endswith(asset) and len(symbol) > len(asset) for asset in _CRYPTO_QUOTE_ASSETS):
        return binance.PROVIDER
    return yahoo.PROVIDER


async def fetch_quote(client: httpx.AsyncClient, symbol: str) -> Quote:
    symbol = normalize_symbol(symbol)
    if provider_for(symbol) == binance.PROVIDER:
        return await binance.fetch_quote(client, symbol)
    return await yahoo.fetch_quote(client, symbol)


async def fetch_bars(client: httpx.AsyncClient, symbol: str, timeframe: Timeframe) -> list[Bar]:
    symbol = normalize_symbol(symbol)
    if provider_for(symbol) == binance.PROVIDER:
        return await binance.fetch_bars(client, symbol, timeframe)
    return await yahoo.fetch_bars(client, symbol, timeframe)


async def search(client: httpx.AsyncClient, query: str, limit: int = 10) -> list[SymbolHit]:
    """
    Only Yahoo is asked. Binance lists a few hundred pairs and no useful search,
    and a symbol typed in full still resolves through `provider_for`.
    """
    return await yahoo.search(client, query, limit)


__all__ = [
    "Bar",
    "ProviderError",
    "Quote",
    "SymbolHit",
    "fetch_bars",
    "fetch_quote",
    "normalize_symbol",
    "provider_for",
    "search",
]
