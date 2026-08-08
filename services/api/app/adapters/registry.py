"""
Which provider serves a symbol.

This decision lives here and only here: a caller asks for `BTCUSDT` or `AAPL`
and gets bars, without learning who answered — plan decision 8.3. Adding a
provider is a case in `provider_for` plus a module beside this one.
"""

import asyncio

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


async def fetch_bars(
    client: httpx.AsyncClient,
    symbol: str,
    timeframe: Timeframe,
    *,
    extended: bool = False,
) -> list[Bar]:
    """
    `extended` is ignored by Binance, which has no session to be outside of:
    crypto trades around the clock, so every bar is a regular one.
    """
    symbol = normalize_symbol(symbol)
    if provider_for(symbol) == binance.PROVIDER:
        return await binance.fetch_bars(client, symbol, timeframe)
    return await yahoo.fetch_bars(client, symbol, timeframe, extended=extended)


async def fetch_quotes(
    client: httpx.AsyncClient,
    symbols: list[str],
) -> tuple[list[Quote], list[tuple[str, ProviderError]]]:
    """
    Quotes for many symbols, in as few upstream calls as the providers allow.

    Equities go to Yahoo in one batch. Crypto goes to Binance one pair at a
    time, because its ticker endpoint takes a single symbol — but crypto lists
    are short and Binance publishes generous limits, so that is not the problem
    Yahoo was.

    Returns what succeeded alongside what did not, rather than failing whole: a
    watchlist of twenty must not go blank because one ticker was delisted.
    """
    wanted = [normalize_symbol(s) for s in symbols if normalize_symbol(s)]
    if not wanted:
        return [], []

    equities = [s for s in wanted if provider_for(s) == yahoo.PROVIDER]
    pairs = [s for s in wanted if provider_for(s) == binance.PROVIDER]

    quotes: list[Quote] = []
    failed: list[tuple[str, ProviderError]] = []

    if equities:
        got, missed = await _yahoo_quotes(client, equities)
        quotes.extend(got)
        failed.extend(missed)

    if pairs:
        settled = await asyncio.gather(
            *(binance.fetch_quote(client, s) for s in pairs), return_exceptions=True
        )
        # `strict` because gather returns exactly one outcome per task: if that
        # ever stopped being true, a symbol would vanish from `failed` instead
        # of being reported, which is what decision 8.8 exists to prevent.
        for symbol, outcome in zip(pairs, settled, strict=True):
            if isinstance(outcome, Quote):
                quotes.append(outcome)
            elif isinstance(outcome, ProviderError):
                failed.append((symbol, outcome))
            else:
                failed.append((symbol, ProviderError("unexpected", str(outcome))))

    return quotes, failed


async def _yahoo_quotes(
    client: httpx.AsyncClient,
    symbols: list[str],
) -> tuple[list[Quote], list[tuple[str, ProviderError]]]:
    """
    The batch, and the fallback that makes depending on it safe.

    The session is the fragile part — cookies expire, the crumb rotates — so a
    refusal drops back to the per-symbol chart endpoint INV-01 built, which
    needs no session at all. Slower and far more requests, but it works when the
    handshake does not, and the alternative is an empty watchlist.
    """
    try:
        batched = await yahoo.fetch_quotes(client, symbols)
    except ProviderError:
        return await _yahoo_one_by_one(client, symbols)

    found = {quote.symbol for quote in batched}
    missing = [s for s in symbols if s not in found]
    if not missing:
        return batched, []

    # Yahoo omits what it does not know rather than saying so. Asking again one
    # at a time turns an absence into a reason.
    extra, failed = await _yahoo_one_by_one(client, missing)
    return [*batched, *extra], failed


async def _yahoo_one_by_one(
    client: httpx.AsyncClient,
    symbols: list[str],
) -> tuple[list[Quote], list[tuple[str, ProviderError]]]:
    settled = await asyncio.gather(
        *(yahoo.fetch_quote(client, s) for s in symbols), return_exceptions=True
    )

    quotes: list[Quote] = []
    failed: list[tuple[str, ProviderError]] = []
    for symbol, outcome in zip(symbols, settled, strict=True):
        if isinstance(outcome, Quote):
            quotes.append(outcome)
        elif isinstance(outcome, ProviderError):
            failed.append((symbol, outcome))
        else:
            failed.append((symbol, ProviderError("unexpected", str(outcome))))
    return quotes, failed


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
    "fetch_quotes",
    "normalize_symbol",
    "provider_for",
    "search",
]
