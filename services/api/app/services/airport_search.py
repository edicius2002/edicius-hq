"""
Finding an airport by typing at it.

The archive already knows where the *watched* airports are — those coordinates
arrive free with every search (decision 12.21). This answers the other
question: which airport is `MAD`, when nobody has ever watched a route through
it. That needs a list of airports nobody has collected, which is a different
kind of data and lives here rather than in `.local-data`: it is reference,
shipped with the code, not something the collector accumulates.

**Server-side rather than bundled.** 4,162 airports is 71 kB gzipped, which
would have roughly doubled the airfare page's download for a feature most
visits never touch. Here it costs the browser about a kilobyte per keystroke
against localhost, and the ranking can be better than a `filter()` in the
browser because the server can afford to look at every row.

Source: OurAirports, which releases its data to the public domain — chosen over
the OpenFlights-derived npm packages, whose data carries ODbL attribution and
share-alike terms that a public repository would have to honour. Filtered to
airports that have an IATA code *and* scheduled commercial service, which is
what turns 81,000 rows into 4,162 places anyone can actually fly to.
"""

import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

DATA = Path(__file__).resolve().parent.parent / "data" / "airports.tsv"

# What a search box can show without scrolling. More than this is a list nobody
# reads; fewer starts hiding the airport you meant.
DEFAULT_LIMIT = 8


@dataclass(frozen=True, slots=True)
class AirportEntry:
    code: str
    city: str
    country: str
    name: str


def fold(text: str) -> str:
    """
    `Chávez` and `chavez` are the same search.

    Accents are decomposed and the combining marks dropped, so a reader typing
    on a keyboard without them still finds Cusco, Chávez and Málaga. Not
    optional in a tool whose default origin is Lima.
    """
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(character for character in decomposed if not unicodedata.combining(character))


@dataclass(frozen=True, slots=True)
class _Indexed:
    entry: AirportEntry
    code: str
    city: str
    name: str


@lru_cache(maxsize=1)
def _airports() -> tuple[_Indexed, ...]:
    """
    The table, read once and folded once.

    Folding 4,162 rows on every keystroke would be the slow part of an
    otherwise trivial search, so it happens at import and never again.
    """
    try:
        lines = DATA.read_text(encoding="utf-8").splitlines()
    except OSError:
        return ()

    rows = []
    for line in lines:
        parts = line.split("\t")
        if len(parts) != 4:
            continue
        code, city, country, name = (part.strip() for part in parts)
        if len(code) != 3:
            continue
        entry = AirportEntry(code=code.upper(), city=city, country=country, name=name)
        rows.append(
            _Indexed(
                entry=entry, code=fold(entry.code), city=fold(entry.city), name=fold(entry.name)
            )
        )
    return tuple(rows)


def _rank(row: _Indexed, needle: str) -> int | None:
    """
    How good a match this is, lower being better, or `None` for no match.

    The order is what a person means by typing three letters: an exact code
    first, because that is the only thing a three-letter query is ever likely
    to be; then a city, because that is how people think about where they are
    going; then the airport's own name, which is the last resort and the one
    that finds "Heathrow" or "Gatwick".
    """
    if row.code == needle:
        return 0
    if row.code.startswith(needle):
        return 1
    if row.city.startswith(needle):
        return 2
    if row.city.find(needle) >= 0:
        return 3
    if row.name.find(needle) >= 0:
        return 4
    return None


def search(query: str, limit: int = DEFAULT_LIMIT) -> list[AirportEntry]:
    """
    Airports matching what has been typed, best first.

    An empty or one-character query returns nothing rather than the first eight
    airports alphabetically: a list that appears before it can mean anything is
    a list that gets dismissed, and then ignored when it does mean something.
    """
    needle = fold(query.strip())
    if len(needle) < 2:
        return []

    scored: list[tuple[int, str, AirportEntry]] = []
    for row in _airports():
        rank = _rank(row, needle)
        if rank is None:
            continue
        # Ties broken by code so the same query always answers the same way —
        # a suggestion list that reshuffles between keystrokes is unusable.
        scored.append((rank, row.entry.code, row.entry))

    scored.sort(key=lambda item: (item[0], item[1]))
    return [entry for _, _, entry in scored[: max(0, limit)]]


def count() -> int:
    """How many airports the table holds. For the health of the thing."""
    return len(_airports())
