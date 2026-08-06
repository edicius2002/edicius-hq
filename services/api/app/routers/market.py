"""
Market data endpoints — Path B.

Nothing here is user state: it is a proxy with a cache in front of it, so none
of it belongs in the KV store and none of it belongs in Postgres later (plan
decisions 5.4 and 5.8).
"""

import asyncio

import httpx
from fastapi import APIRouter, HTTPException, Query, status
from pydantic import BaseModel

from app.adapters import registry
from app.adapters.models import ProviderError
from app.config import (
    DEFAULT_TIMEFRAME,
    MAX_BATCH_SYMBOLS,
    QUOTE_TTL_SECONDS,
    TIMEFRAMES,
    UPSTREAM_TIMEOUT_SECONDS,
)
from app.services.market_cache import BarCache, MemoryCache

router = APIRouter(prefix="/api/market", tags=["market"])

quote_cache = MemoryCache(QUOTE_TTL_SECONDS)
bar_cache = BarCache()

_client: httpx.AsyncClient | None = None


def get_client() -> httpx.AsyncClient:
    global _client
    if _client is None:
        _client = httpx.AsyncClient(
            timeout=UPSTREAM_TIMEOUT_SECONDS,
            follow_redirects=True,
        )
    return _client


async def close_client() -> None:
    global _client
    if _client is not None:
        await _client.aclose()
        _client = None


class QuoteModel(BaseModel):
    symbol: str
    price: float
    currency: str
    previousClose: float | None
    change: float | None
    changePercent: float | None
    provider: str


class QuoteFailure(BaseModel):
    symbol: str
    code: str
    message: str


class QuotesResponse(BaseModel):
    quotes: list[QuoteModel]
    # One bad symbol must not sink the other nineteen, so failures ride along
    # beside the successes instead of replacing them.
    failed: list[QuoteFailure]


class BarModel(BaseModel):
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


class BarsResponse(BaseModel):
    symbol: str
    timeframe: str
    provider: str
    bars: list[BarModel]


class SymbolHitModel(BaseModel):
    symbol: str
    name: str
    kind: str
    exchange: str | None


class SearchResponse(BaseModel):
    results: list[SymbolHitModel]


@router.get("/quotes", response_model=QuotesResponse)
async def get_quotes(
    symbols: str = Query(..., description="Comma-separated symbols"),
) -> QuotesResponse:
    wanted = _parse_symbols(symbols)
    if not wanted:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "At least one symbol is required")

    client = get_client()

    async def one(symbol: str):
        return await quote_cache.fetch(symbol, lambda: registry.fetch_quote(client, symbol))

    settled = await asyncio.gather(*(one(s) for s in wanted), return_exceptions=True)

    quotes: list[QuoteModel] = []
    failed: list[QuoteFailure] = []
    for symbol, outcome in zip(wanted, settled):
        if isinstance(outcome, ProviderError):
            failed.append(QuoteFailure(symbol=symbol, code=outcome.code, message=outcome.message))
        elif isinstance(outcome, BaseException):
            failed.append(QuoteFailure(symbol=symbol, code="unexpected", message=str(outcome)))
        else:
            quotes.append(
                QuoteModel(
                    symbol=outcome.symbol,
                    price=outcome.price,
                    currency=outcome.currency,
                    previousClose=outcome.previous_close,
                    change=outcome.change,
                    changePercent=outcome.change_percent,
                    provider=outcome.provider,
                )
            )

    return QuotesResponse(quotes=quotes, failed=failed)


@router.get("/bars", response_model=BarsResponse)
async def get_bars(
    symbol: str = Query(...),
    timeframe: str = Query(DEFAULT_TIMEFRAME),
) -> BarsResponse:
    frame = TIMEFRAMES.get(timeframe)
    if frame is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown timeframe '{timeframe}'. Known: {', '.join(TIMEFRAMES)}",
        )

    resolved = registry.normalize_symbol(symbol)
    client = get_client()

    try:
        bars = await bar_cache.fetch(
            resolved,
            frame.key,
            frame.ttl,
            lambda: registry.fetch_bars(client, resolved, frame),
        )
    except ProviderError as exc:
        raise _as_http_error(exc) from exc

    return BarsResponse(
        symbol=resolved,
        timeframe=frame.key,
        provider=registry.provider_for(resolved),
        bars=[BarModel(**{k: getattr(bar, k) for k in BarModel.model_fields}) for bar in bars],
    )


@router.get("/search", response_model=SearchResponse)
async def get_search(
    q: str = Query(..., min_length=1),
    limit: int = Query(10, ge=1, le=25),
) -> SearchResponse:
    try:
        hits = await registry.search(get_client(), q, limit)
    except ProviderError as exc:
        raise _as_http_error(exc) from exc

    return SearchResponse(
        results=[
            SymbolHitModel(symbol=h.symbol, name=h.name, kind=h.kind, exchange=h.exchange)
            for h in hits
        ]
    )


@router.get("/timeframes")
def get_timeframes() -> dict[str, list[str]]:
    """What the chart may ask for, so the client does not keep its own copy."""
    return {"timeframes": list(TIMEFRAMES)}


def _parse_symbols(raw: str) -> list[str]:
    seen: list[str] = []
    for part in raw.split(","):
        symbol = registry.normalize_symbol(part)
        if symbol and symbol not in seen:
            seen.append(symbol)
    return seen[:MAX_BATCH_SYMBOLS]


def _as_http_error(exc: ProviderError) -> HTTPException:
    """Upstream trouble is reported as itself, not as a blank result."""
    if exc.code == "symbol-not-found":
        return HTTPException(status.HTTP_404_NOT_FOUND, exc.message)
    if exc.code == "rate-limited":
        return HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, exc.message)
    return HTTPException(status.HTTP_502_BAD_GATEWAY, exc.message)
