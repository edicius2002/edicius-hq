"""
Yahoo Finance, for equities, ETFs and indices.

Unofficial and undocumented: it can change without notice, and it throttles a
single IP at a few hundred requests a day. That ceiling is why nothing here is
called directly — every entry point goes through the cache in
`app.services.market_cache`, which is what keeps the request count survivable.

Quotes are read off the chart endpoint rather than Yahoo's own quote endpoint,
which now demands a cookie and a crumb and is rate-limited harder. One extra
field parsed here buys not having to maintain a session handshake.
"""

from typing import Any

import httpx

from app.adapters.models import Bar, ProviderError, Quote, SymbolHit
from app.config import Timeframe

PROVIDER = "yahoo"

# Two hosts serving the same API. The second is tried when the first refuses,
# which it does often enough to matter.
CHART_HOSTS = (
    "https://query1.finance.yahoo.com",
    "https://query2.finance.yahoo.com",
)
SEARCH_HOST = "https://query2.finance.yahoo.com"

# A default client identifies itself as Python and is refused more often.
HEADERS = {"User-Agent": "Mozilla/5.0 (compatible; EdiciusHQ/1.0)"}


async def _get_json(client: httpx.AsyncClient, path: str, params: dict[str, Any]) -> Any:
    last: Exception | None = None

    for host in CHART_HOSTS:
        try:
            response = await client.get(f"{host}{path}", params=params, headers=HEADERS)
        except httpx.HTTPError as exc:
            last = exc
            continue

        if response.status_code == 404:
            raise ProviderError("symbol-not-found", "Yahoo does not know that symbol")
        if response.status_code == 429:
            raise ProviderError("rate-limited", "Yahoo is rate limiting this address")
        if response.status_code >= 400:
            last = ProviderError("upstream-error", f"Yahoo answered {response.status_code}")
            continue

        try:
            return response.json()
        except ValueError as exc:
            last = exc

    raise ProviderError("unreachable", f"Yahoo could not be reached: {last}")


def _first_result(payload: Any) -> dict[str, Any]:
    chart = (payload or {}).get("chart") or {}
    error = chart.get("error")
    if error:
        raise ProviderError("upstream-error", str(error.get("description") or error))

    results = chart.get("result") or []
    if not results:
        raise ProviderError("symbol-not-found", "Yahoo returned no data for that symbol")
    return results[0]


async def fetch_quote(client: httpx.AsyncClient, symbol: str) -> Quote:
    payload = await _get_json(
        client,
        f"/v8/finance/chart/{symbol}",
        {"interval": "1d", "range": "5d", "includePrePost": "false"},
    )
    meta = _first_result(payload).get("meta") or {}

    price = meta.get("regularMarketPrice")
    if price is None:
        raise ProviderError("no-price", "Yahoo returned no price", symbol=symbol)

    return Quote(
        symbol=symbol,
        price=float(price),
        currency=str(meta.get("currency") or "USD").upper(),
        previous_close=(
            float(meta["chartPreviousClose"]) if meta.get("chartPreviousClose") is not None else None
        ),
        provider=PROVIDER,
    )


async def fetch_bars(
    client: httpx.AsyncClient,
    symbol: str,
    timeframe: Timeframe,
    *,
    extended: bool = False,
) -> list[Bar]:
    """`extended` asks for pre- and post-market bars as well as the session."""
    payload = await _get_json(
        client,
        f"/v8/finance/chart/{symbol}",
        {
            "interval": timeframe.yahoo_interval,
            "range": timeframe.yahoo_range,
            "includePrePost": "true" if extended else "false",
        },
    )
    return parse_bars(payload, timeframe.limit)


def parse_bars(payload: Any, limit: int) -> list[Bar]:
    """
    Split out so it can be tested against a recorded response without a network.

    Yahoo pads its series with nulls where a bar is missing — a holiday, a
    halt, a gap in its own data. Those rows are dropped rather than carried as
    zeroes, which would draw a candle crashing to nothing.
    """
    result = _first_result(payload)
    stamps = result.get("timestamp") or []
    quote = ((result.get("indicators") or {}).get("quote") or [{}])[0]

    opens, highs = quote.get("open") or [], quote.get("high") or []
    lows, closes = quote.get("low") or [], quote.get("close") or []
    volumes = quote.get("volume") or []

    bars: list[Bar] = []
    for i, stamp in enumerate(stamps):
        try:
            o, h, low, c = opens[i], highs[i], lows[i], closes[i]
        except IndexError:
            break
        if None in (o, h, low, c) or stamp is None:
            continue

        volume = volumes[i] if i < len(volumes) and volumes[i] is not None else 0
        bars.append(
            Bar(
                time=int(stamp),
                open=float(o),
                high=float(h),
                low=float(low),
                close=float(c),
                volume=float(volume),
            )
        )

    # Newest bars are the ones worth keeping when the cap bites.
    return bars[-limit:] if limit and len(bars) > limit else bars


async def search(client: httpx.AsyncClient, query: str, limit: int = 10) -> list[SymbolHit]:
    try:
        response = await client.get(
            f"{SEARCH_HOST}/v1/finance/search",
            params={"q": query, "quotesCount": limit, "newsCount": 0},
            headers=HEADERS,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ProviderError("unreachable", f"Yahoo search failed: {exc}") from exc

    return parse_search(payload, limit)


def parse_search(payload: Any, limit: int) -> list[SymbolHit]:
    hits: list[SymbolHit] = []
    for row in (payload or {}).get("quotes") or []:
        symbol = row.get("symbol")
        if not symbol:
            continue
        hits.append(
            SymbolHit(
                symbol=str(symbol).upper(),
                name=str(row.get("shortname") or row.get("longname") or symbol),
                kind=str(row.get("quoteType") or "EQUITY").lower(),
                exchange=row.get("exchange"),
            )
        )
        if len(hits) >= limit:
            break
    return hits
