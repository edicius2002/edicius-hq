"""
The cookie-and-crumb handshake Yahoo's batch quote endpoint demands.

INV-01 deliberately did without this: reading quotes one symbol at a time off
the chart endpoint needs no session, and no session is one less thing to break.
INV-03 measured what that costs once a watchlist exists — around 15,600 upstream
requests a day for ten symbols — against 1,560 batched, flat in the number of
symbols.

So the handshake is worth having, but not worth depending on. Cookies expire and
the crumb rotates; everything here is written so that failing is cheap and the
caller can fall back to the path that never needed a session.
"""

import asyncio
import time
from dataclasses import dataclass

import httpx

# Visiting this sets the consent cookies the crumb endpoint checks. It answers
# 404, which is fine: the cookies are the point, not the body.
CONSENT_URL = "https://fc.yahoo.com"
CRUMB_URL = "https://query2.finance.yahoo.com/v1/test/getcrumb"

# A default client identifies itself as a script and is refused; this one is not.
BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# Re-handshaken well before Yahoo would expire it, so a rotation shows up as one
# slow request rather than a failed one.
SESSION_TTL_SECONDS = 30 * 60


@dataclass(slots=True)
class Crumb:
    value: str
    obtained_at: float

    def is_fresh(self, now: float) -> bool:
        return bool(self.value) and now - self.obtained_at < SESSION_TTL_SECONDS


class YahooSession:
    """
    Holds one crumb and the cookies that make it valid.

    A single lock guards the handshake so ten symbols arriving together produce
    one negotiation rather than ten — the same reasoning as the coalescing in
    the bar cache, applied to a thing that is far more expensive to repeat.
    """

    def __init__(self) -> None:
        self._crumb: Crumb | None = None
        self._lock = asyncio.Lock()

    def forget(self) -> None:
        """Called when a request is refused, so the next one negotiates again."""
        self._crumb = None

    async def crumb(self, client: httpx.AsyncClient, *, now: float | None = None) -> str | None:
        # One clock for the whole call. Reading the real one again inside the
        # lock while a test injected a different one would make the two checks
        # disagree, and the second would quietly undo the first.
        read_now = (lambda: time.monotonic()) if now is None else (lambda: now)

        current = self._crumb
        if current is not None and current.is_fresh(read_now()):
            return current.value

        async with self._lock:
            # Someone may have negotiated while this call waited for the lock.
            current = self._crumb
            if current is not None and current.is_fresh(read_now()):
                return current.value

            value = await self._negotiate(client)
            if value is None:
                return None
            self._crumb = Crumb(value=value, obtained_at=read_now())
            return value

    async def _negotiate(self, client: httpx.AsyncClient) -> str | None:
        headers = {"User-Agent": BROWSER_UA}
        try:
            # The response is discarded; the cookies it sets on the client are not.
            await client.get(CONSENT_URL, headers=headers)
            response = await client.get(CRUMB_URL, headers=headers)
        except httpx.HTTPError:
            return None

        if response.status_code != 200:
            return None

        crumb = response.text.strip()
        # A crumb is a short opaque token. Anything long is an error page, and a
        # page pasted into a query string would fail in a far more confusing way.
        if not crumb or len(crumb) > 32 or "<" in crumb:
            return None
        return crumb


SESSION = YahooSession()
