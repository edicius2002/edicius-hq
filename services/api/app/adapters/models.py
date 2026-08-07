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
