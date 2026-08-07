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
from app.adapters.yahoo_session import BROWSER_UA, SESSION
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


QUOTE_URL = "https://query2.finance.yahoo.com/v7/finance/quote"


async def fetch_quotes(client: httpx.AsyncClient, symbols: list[str]) -> list[Quote]:
    """
    Every symbol in one request.

    Ten times fewer upstream calls than asking one at a time, and flat in the
    number of symbols — forty cost the same as ten. The price is the session in
    `yahoo_session`, which is why every failure here raises rather than guesses:
    the caller falls back to the per-symbol path that needs no session.
    """
    if not symbols:
        return []

    crumb = await SESSION.crumb(client)
    if crumb is None:
        raise ProviderError("no-session", "Could not negotiate a Yahoo session")

    try:
        response = await client.get(
            QUOTE_URL,
            params={"symbols": ",".join(symbols), "crumb": crumb},
            headers={"User-Agent": BROWSER_UA},
        )
    except httpx.HTTPError as exc:
        raise ProviderError("unreachable", f"Yahoo could not be reached: {exc}") from exc

    if response.status_code in (401, 403):
        # The crumb went stale or the cookies were dropped. Forgetting it means
        # the next attempt negotiates instead of failing the same way forever.
        SESSION.forget()
        raise ProviderError("no-session", "Yahoo refused the session")
    if response.status_code == 429:
        raise ProviderError("rate-limited", "Yahoo is rate limiting this address")
    if response.status_code >= 400:
        raise ProviderError("upstream-error", f"Yahoo answered {response.status_code}")

    try:
        payload = response.json()
    except ValueError as exc:
        raise ProviderError("upstream-error", f"Yahoo sent something unreadable: {exc}") from exc

    return parse_quotes(payload)


def parse_quotes(payload: object) -> list[Quote]:
    """
    Split out so the shape is pinned by tests rather than by an endpoint being
    up. A symbol Yahoo does not know is simply absent from the result, so the
    caller compares what it asked for against what came back.
    """
    if not isinstance(payload, dict):
        raise ProviderError("upstream-error", "Yahoo sent something that is not a response")

    container = payload.get("quoteResponse")
    if not isinstance(container, dict):
        raise ProviderError("upstream-error", "Yahoo sent no quoteResponse")

    error = container.get("error")
    if error:
        raise ProviderError("upstream-error", str(error))

    quotes: list[Quote] = []
    for row in container.get("result") or []:
        if not isinstance(row, dict):
            continue
        symbol = row.get("symbol")
        state = str(row.get("marketState") or "")
        price, extended = _live_price(row, state)
        if not symbol or price is None:
            continue

        # Measured against the regular close even when the price is an extended
        # one, so the percentage still answers "how is it doing today" rather
        # than "how far has it drifted since the bell".
        previous = row.get("regularMarketPreviousClose")
        quotes.append(
            Quote(
                symbol=str(symbol).upper(),
                price=float(price),
                currency=str(row.get("currency") or "USD").upper(),
                previous_close=float(previous) if previous is not None else None,
                provider=PROVIDER,
                # The exchange's own view of its session, which a clock cannot
                # give: it knows about holidays.
                market_state=state or None,
                name=str(row.get("shortName") or row.get("longName") or "") or None,
                extended=extended,
            )
        )
    return quotes


# Which field carries the live price, by session. Outside regular hours the
# regular price is yesterday's news — showing it while the market moves is the
# thing this exists to avoid.
_EXTENDED_PRICE_FIELD = {
    "PRE": "preMarketPrice",
    "PREPRE": "preMarketPrice",
    "POST": "postMarketPrice",
    "POSTPOST": "postMarketPrice",
}


def _live_price(row: dict, state: str) -> tuple[float | None, bool]:
    """
    The most recent traded price, and whether it came from an extended session.

    Falls back to the regular price rather than reporting nothing: an extended
    session with no trades yet has no extended price, and a stale number beats
    an empty row.
    """
    field = _EXTENDED_PRICE_FIELD.get(state)
    if field is not None:
        value = row.get(field)
        if value is not None:
            return float(value), True

    regular = row.get("regularMarketPrice")
    return (float(regular) if regular is not None else None), False
