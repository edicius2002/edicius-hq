"""
The shape the rest of the API speaks, whichever provider answered.

Nothing outside `app.adapters` names a provider — see plan decision 8.3. These
types are the whole contract: if Yahoo is replaced tomorrow, only the modules
next to this file change.
"""

from dataclasses import dataclass


class ProviderError(Exception):
    """
    An upstream refused, timed out or answered with something unusable.

    Carries a machine-readable `code` so the client can tell "the market data
    provider is down" from "that symbol does not exist" and render each
    differently, rather than showing an empty panel for both.
    """

    def __init__(self, code: str, message: str, *, symbol: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.symbol = symbol


@dataclass(frozen=True, slots=True)
class Quote:
    symbol: str
    price: float
    currency: str
    # The previous close, when upstream reports one. Change is derived rather
    # than stored, so it can never disagree with the price beside it.
    previous_close: float | None
    provider: str
    # The provider's market timestamp, in Unix seconds. It is deliberately
    # nullable: making up a client-side time would make it incomparable with
    # streaming ticks from the exchange.
    time: float | None = None
    # What the exchange says about its own session — REGULAR, PRE, POST,
    # POSTPOST, CLOSED. Absent from providers that have no session to report.
    market_state: str | None = None
    # Only the batch endpoint carries it, so a quote from elsewhere has none.
    name: str | None = None
    # Whether `price` came from a pre- or post-market session rather than the
    # regular one. The change is still measured against the regular close, so
    # the number answers "how is it doing" rather than "how has it moved since
    # the bell", which is a different and less useful question at a glance.
    extended: bool = False

    @property
    def change(self) -> float | None:
        if self.previous_close is None or self.previous_close == 0:
            return None
        return self.price - self.previous_close

    @property
    def change_percent(self) -> float | None:
        change = self.change
        if change is None or self.previous_close in (None, 0):
            return None
        return change / self.previous_close * 100


@dataclass(frozen=True, slots=True)
class Bar:
    """One candle. `time` is a Unix timestamp in seconds, UTC."""

    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float


@dataclass(frozen=True, slots=True)
class SymbolHit:
    symbol: str
    name: str
    kind: str
    exchange: str | None = None


# The words the client understands, and the only ones either path may send.
#
# Yahoo's REST endpoint and its socket describe the same sessions differently —
# `POSTPOST` against `POST`, and a socket-only `EXTENDED` the client had no
# branch for at all, so a tick carrying it was rendered as though it were a
# regular-session price. Both paths map into this set now.
REGULAR = "REGULAR"
PRE = "PRE"
POST = "POST"
CLOSED = "CLOSED"

MARKET_SESSIONS = frozenset({REGULAR, PRE, POST, CLOSED})

# Yahoo's REST vocabulary, which doubles some of these for reasons of its own.
_REST_SESSIONS = {
    "REGULAR": REGULAR,
    "PRE": PRE,
    "PREPRE": PRE,
    "POST": POST,
    "POSTPOST": POST,
    "CLOSED": CLOSED,
}


def canonical_session(raw: str | None) -> str | None:
    """One vocabulary, whichever endpoint the words came from."""
    if not raw:
        return None
    return _REST_SESSIONS.get(raw.upper())


def is_extended_session(session: str | None) -> bool:
    """
    Whether a price from this session is an extended-hours one.

    Decided here rather than in the browser, because it was decided in both:
    the REST path computed `extended` on the server and the streaming path let
    the client infer it from a string, so the two could disagree — and did.
    """
    return session in {PRE, POST}


@dataclass(frozen=True, slots=True)
class Tick:
    """
    One price as a socket reports it. Deliberately thinner than a `Quote`.

    Here rather than inside an adapter because it is the contract, not one
    provider's idea of it — decision 8.3. It lived in `yahoo_stream` while
    `binance_stream` and the hub both imported it from there, which made the
    shape of the whole streaming path depend on the file for one upstream.
    """

    symbol: str
    price: float
    provider: str
    #: The exchange's own word for the session this trade happened in.
    market_state: str | None = None
    change_percent: float | None = None
    #: Seconds since the epoch, as the exchange stamped it.
    time: float | None = None

    @property
    def extended(self) -> bool:
        return is_extended_session(self.market_state)
