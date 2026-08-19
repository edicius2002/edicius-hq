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
class Airport:
    """
    Where an IATA code actually is.

    Google ships this with every search — `payload[1]` carries the code, the
    full name, the city, the country and the coordinates for each airport in
    the query. Before this the repository knew `LIM` only as three letters that
    matched a regular expression, and any map would have needed a bundled
    lookup table larger than the map library itself.
    """

    code: str
    name: str | None
    city: str | None
    country: str | None
    latitude: float
    longitude: float


@dataclass(frozen=True, slots=True)
class PricePoint:
    """
    One day and one price, from the history Google ships with every search.

    Measured 2026-08-18: the payload carries 61 of these, spaced exactly 24
    hours, ending today, and scoped to the search rather than the route — two
    departure dates on one route return different series. The value is always
    an integer: this series is rounded where `FareOffer.price` is not, so the
    two must never be drawn as the same kind of measurement.
    """

    #: `YYYY-MM-DD`. The stamps arrive as local midnight at the origin.
    date: str
    price: float


@dataclass(frozen=True, slots=True)
class CalendarQuery:
    """
    One city pair and a window of **departure dates** to price.

    Deliberately not a `FareQuery` with two more fields. A query names one
    departure and comes back with a board; this names a range and comes back
    with one number per day inside it, so the two cannot share a result type
    and sharing an argument type would only invite a caller to pass one where
    the other is meant.
    """

    origin: str
    destination: str
    #: First departure date wanted, `YYYY-MM-DD`.
    start: str
    #: Last departure date wanted, inclusive.
    end: str
    currency: str = "USD"

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"


@dataclass(frozen=True, slots=True)
class CalendarPrice:
    """
    One departure date and the cheapest fare on it, or no fare at all.

    Not a `PricePoint`, whose `date` is *when a price was observed*. Here the
    date is the day the flight leaves and the observation time belongs to the
    whole curve. Drawing the two on one axis would silently mix "what this
    route cost over the last sixty days" with "what each of the next eleven
    months costs today".

    `price` is `None` when the provider answered about the date and had nothing
    to sell on it. That is a real answer and is kept rather than dropped: a
    missing date and a date with no flights mean different things, and only one
    of them is a gap in our own collection.
    """

    #: `YYYY-MM-DD`, the departure.
    departure_date: str
    price: float | None


@dataclass(frozen=True, slots=True)
class FareInsights:
    """
    Google's own sense of what this search usually costs.

    Useful as a second yardstick — it answers "is today cheap for this route"
    with two months of context we did not have to collect. Every field is
    optional because the block is absent on thin routes and beyond roughly 330
    days out.

    The payload carries a fifth number next to these whose definition could not
    be pinned down from three routes (60 against a typical of 48 reported -13,
    which is not the percentage). It is deliberately not stored: a number we
    cannot define is a number nobody can read later.
    """

    typical: float | None = None
    usual_low: float | None = None
    usual_high: float | None = None


@dataclass(frozen=True, slots=True)
class SearchResult:
    """
    Everything one search answered with.

    One request returns the itinerary list, the 60-day history and the
    insights, so one call returns all three. Splitting them into separate
    functions would invite a second request for data we already downloaded —
    and requests are the scarce thing here, not parsing.
    """

    offers: list[FareOffer]
    history: list[PricePoint] = field(default_factory=list)
    insights: FareInsights | None = None
    #: The airports named in the query, with coordinates. Free with the search.
    airports: list[Airport] = field(default_factory=list)


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
    #: What the provider says this search usually costs, when it says anything.
    insights: FareInsights | None = None

    @property
    def route(self) -> str:
        return f"{self.origin}-{self.destination}"

    @property
    def cheapest(self) -> FareOffer | None:
        return min(self.offers, key=lambda offer: offer.price, default=None)
