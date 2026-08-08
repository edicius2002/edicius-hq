"""
Market data endpoints — Path B.

Nothing here is user state: it is a proxy with a cache in front of it, so none
of it belongs in the KV store and none of it belongs in Postgres later (plan
decisions 5.4 and 5.8).
"""

import asyncio
import json
from collections.abc import AsyncIterator

import httpx
from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.adapters import registry
from app.adapters.models import ProviderError, Quote
from app.config import (
    DEFAULT_TIMEFRAME,
    MAX_BATCH_SYMBOLS,
    QUOTE_TTL_SECONDS,
    TIMEFRAMES,
    UPSTREAM_TIMEOUT_SECONDS,
)
from app.services.market_cache import BarCache, MemoryCache
from app.services.stream_hub import HUB

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
    # The exchange's own view of its session; absent where there is no session.
    marketState: str | None = None
    name: str | None = None
    extended: bool = False


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
    # Echoed back so the client knows whether what it holds includes the
    # extended session, without having to remember what it asked for.
    extended: bool
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

    # Whatever is still fresh is answered from memory; only the rest is asked
    # for, and those go upstream together rather than one request each.
    quotes: list[QuoteModel] = []
    stale: list[str] = []
    for symbol in wanted:
        cached = quote_cache.get(symbol)
        if isinstance(cached, Quote):
            quotes.append(_as_model(cached))
        else:
            stale.append(symbol)

    failed: list[QuoteFailure] = []
    if stale:
        try:
            fetched, refused = await registry.fetch_quotes(client, stale)
        except ProviderError as exc:
            return QuotesResponse(
                quotes=quotes,
                failed=[QuoteFailure(symbol=s, code=exc.code, message=exc.message) for s in stale],
            )

        for quote in fetched:
            quote_cache.put(quote.symbol, quote)
            quotes.append(_as_model(quote))
        failed.extend(
            QuoteFailure(symbol=symbol, code=error.code, message=error.message)
            for symbol, error in refused
        )

    # Answered in the order asked for, so a list does not reshuffle itself when
    # part of it comes from cache and part from upstream.
    order = {symbol: index for index, symbol in enumerate(wanted)}
    quotes.sort(key=lambda q: order.get(q.symbol, len(order)))
    return QuotesResponse(quotes=quotes, failed=failed)


def _as_model(quote: Quote) -> QuoteModel:
    return QuoteModel(
        symbol=quote.symbol,
        price=quote.price,
        currency=quote.currency,
        previousClose=quote.previous_close,
        change=quote.change,
        changePercent=quote.change_percent,
        provider=quote.provider,
        marketState=quote.market_state,
        name=quote.name,
        extended=quote.extended,
    )


@router.get("/bars", response_model=BarsResponse)
async def get_bars(
    symbol: str = Query(...),
    timeframe: str = Query(DEFAULT_TIMEFRAME),
    extended: bool = Query(False, description="Include pre- and post-market bars"),
) -> BarsResponse:
    frame = TIMEFRAMES.get(timeframe)
    if frame is None:
        raise HTTPException(
            status.HTTP_400_BAD_REQUEST,
            f"Unknown timeframe '{timeframe}'. Known: {', '.join(TIMEFRAMES)}",
        )

    resolved = registry.normalize_symbol(symbol)
    client = get_client()

    # Two different series, so two different cache entries.
    cache_key = f"{frame.key}ext" if extended else frame.key
    try:
        bars = await bar_cache.fetch(
            resolved,
            cache_key,
            frame.ttl,
            lambda: registry.fetch_bars(client, resolved, frame, extended=extended),
        )
    except ProviderError as exc:
        raise _as_http_error(exc) from exc

    return BarsResponse(
        symbol=resolved,
        timeframe=frame.key,
        provider=registry.provider_for(resolved),
        extended=extended,
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


# How long a listener may hear nothing before we say so. A proxy that sees no
# bytes assumes the connection died; a comment frame is the cheapest way to
# disagree, and it doubles as the signal that the pipe is still open on a night
# when genuinely nothing trades.
HEARTBEAT_SECONDS = 20.0


def sse(event: str, data: object) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


def tick_payload(tick) -> dict:
    """Deliberately the fields a row needs, and no provider name among them."""
    return {
        "symbol": tick.symbol,
        "price": tick.price,
        "marketState": tick.market_state,
        "changePercent": tick.change_percent,
        "time": tick.time,
    }


@router.get("/stream")
async def stream_quotes(
    request: Request,
    symbols: str = Query(..., description="Comma-separated symbols to follow"),
) -> StreamingResponse:
    """
    Live prices, pushed.

    Server-sent events rather than a socket to the browser: this direction is
    the only one carrying anything, and an EventSource reconnects by itself.
    The upstream socket stays on this side of the wire, where decision 8.3 says
    the provider's name belongs.

    **This does not replace polling.** The socket carries trades, so a symbol
    that does not trade says nothing, and it never sends a previous close. The
    sweep on `/quotes` remains the source of truth — see decision 8.18.
    """
    # Shares the parser with /quotes, so a symbol that streams is spelled
    # exactly like the one that is swept — and the same cap applies.
    wanted = _parse_symbols(symbols)
    if not wanted:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "No symbols given.")

    async def events() -> AsyncIterator[str]:
        # Said before the first tick so the client knows the pipe is open even
        # if the market is dead quiet.
        yield sse("open", {"symbols": sorted(wanted)})

        listener = HUB.listen(set(wanted))
        try:
            while True:
                try:
                    batch = await asyncio.wait_for(anext(listener), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                except StopAsyncIteration:
                    return

                if await request.is_disconnected():
                    return
                yield sse("quotes", [tick_payload(t) for t in batch])
        finally:
            await listener.aclose()

    return StreamingResponse(
        events(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            # Nginx buffers by default, which would hold a tick until the
            # buffer filled — the exact latency this endpoint exists to remove.
            "X-Accel-Buffering": "no",
        },
    )
