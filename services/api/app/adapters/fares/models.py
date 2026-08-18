"""
The shape the airfare feature speaks, whichever provider answered.

Same contract that `app.adapters.models` sets for market data, and for the same
reason — decision 8.3. Nothing outside `app.adapters.fares` names a provider,
so replacing one is a module change and not a feature change.
"""

from dataclasses import dataclass, field


class FareError(Exception):
    """
    A fare provider refused, timed out, or answered with something unusable.

    Carries a machine-readable `code` for the same reason `ProviderError` does:
    "the scraper stopped understanding the page" and "that route has no flights
    that day" look identical from the outside and must not.
    """

    def __init__(self, code: str, message: str, *, route: str | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.route = route


@dataclass(frozen=True, slots=True)
class FareQuery:
    """One route on one set of dates. `return_date` absent means one way."""

    origin: str
    destination: str
    flight_date: str
    return_date: str | None = None
    currency: str = "USD"

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"


@dataclass(frozen=True, slots=True)
class FareOffer:
    """One itinerary as a provider reports it."""

    #: Marketing carrier, IATA. `LA`, `H2`, `AV`.
    airline: str
    #: Human-readable carrier, when the provider supplies one.
    airline_name: str | None
    #: First leg's flight number. Deliberately not a list: the number is here to
    #: identify the departure a human is looking at, not to reconstruct the
    #: whole itinerary, which `transfers` and `duration_minutes` already bound.
    flight_number: str | None
    #: Local departure time at the origin, ISO 8601 without a zone. Google
    #: reports wall-clock at the airport and no offset; inventing UTC here would
    #: be a lie that later arithmetic would take seriously.
    departure_at: str
    arrival_at: str | None
    transfers: int
    duration_minutes: int | None
    price: float
    currency: str


@dataclass(frozen=True, slots=True)
class FareSnapshot:
    """
    Every offer a provider had for one route on one flight date, at one moment.

    The snapshot is the unit of history: a price only means something next to
    when it was observed, so `captured_at` is not metadata here, it is the key.
    """

    captured_at: str
    source: str
    origin: str
    destination: str
    flight_date: str
    return_date: str | None
    currency: str
    offers: list[FareOffer] = field(default_factory=list)

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"

    @property
    def cheapest(self) -> FareOffer | None:
        return min(self.offers, key=lambda offer: offer.price, default=None)
