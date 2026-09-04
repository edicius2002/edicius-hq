"""
The preamble the airfare test modules in this directory share.

Four files — `test_fares.py`, `test_fares_budget.py`, `test_fares_calendar.py`
and `test_fares_schedule.py` — had grown to 5,567 lines and 216 tests between
them, each carrying half a dozen section banners that were already the seams a
reader navigated by. They are twelve modules now, one per subject, and this is
what more than one of them needs.

Nothing here is a pytest fixture: these are plain helpers, imported by name
(`from conftest import read_fixture`). The three `autouse` fixtures that give
every test its own data directory, an unpaced `GOOGLE_PACER` and a session on
every request stay in `tests/conftest.py` one level up, where they apply to this
subtree as they did before.

`offer` and `snapshot` here are the flavour `test_fares.py` used. The schedule
tests have their own pair under the same two names and a different signature —
they build a snapshot out of loose offers rather than out of a list of prices —
and those stay local to the modules that use them. Collapsing the two into one
function would mean a helper with two shapes bolted together, which is worse
than the homonym.
"""

import json
from datetime import UTC, datetime
from pathlib import Path

import httpx

from app.adapters.fares.models import CalendarPrice, FareOffer, FareQuery, FareSnapshot
from app.services.fare_calendar import CalendarCurve
from app.services.fare_schedule import month_dates

# One directory up from here: the fixtures did not move, only the tests that
# read them.
FIXTURES = Path(__file__).parent.parent / "fixtures"

#: The captured board every collector test spends against.
BOARD = "google_flights_lim_scl.html"

#: A real calendar answer, captured live on 2026-08-19: LIM-CUZ, the twenty-one
#: departure dates from 2026-12-09 to 2026-12-29. Kept verbatim —
#: `.prettierignore` excludes that directory precisely so nothing reformats the
#: bytes the positions in `test_calendar_adapter` are pinned against.
CAPTURE = "google_flights_calendar_lim_cuz.txt"

#: The same endpoint refusing. Asking for the whole 331-date horizon in one
#: request answered HTTP 200 with gRPC status 3 where the payload goes.
REFUSAL = "google_flights_calendar_refused.txt"

#: The same two files under the names the budget tests gave them, kept because
#: renaming a constant across forty assertions is not what this change is.
CALENDAR_CAPTURE = CAPTURE
CALENDAR_REFUSAL = REFUSAL

NOW = datetime(2026, 8, 18, 12, 0, tzinfo=UTC)
TODAY = NOW.date()


def read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def read_payload(name: str):
    """
    A captured `ds:1` data array, already out of its page.

    Kept as the array rather than as the 3.2 MB page it came in, for the same
    reason `google_flights_airports.json` is: `extract_payload` has its own
    tests, and pinning the parser does not need the megabytes of markup that
    the extractor already proved it can get through.
    """
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def offer(
    price: float,
    *,
    airline: str = "LA",
    departure: str = "2026-10-16T08:00",
    via_points: tuple[str, ...] | None = None,
) -> FareOffer:
    return FareOffer(
        airline=airline,
        airline_name="LATAM",
        flight_number="529",
        departure_at=departure,
        arrival_at="2026-10-16T12:00",
        transfers=0,
        duration_minutes=240,
        price=price,
        currency="USD",
        via_points=via_points,
    )


def snapshot(captured_at: str, *, prices: list[float], origin="LIM", destination="SCL"):
    return FareSnapshot(
        captured_at=captured_at,
        source="google-flights",
        origin=origin,
        destination=destination,
        flight_date="2026-10-16",
        return_date=None,
        currency="USD",
        offers=[offer(price) for price in prices],
    )


def board_queries(month: str = "2026-10") -> list[FareQuery]:
    """One month of departures, nearest first — the order a pass spends in."""
    return [
        FareQuery(origin="LIM", destination="SCL", flight_date=day, return_date=None)
        for day in month_dates(month)
    ]


def curve(captured_at: str, *, prices, origin="LIM", destination="CUZ") -> CalendarCurve:
    return CalendarCurve(
        captured_at=captured_at,
        source="google-flights",
        origin=origin,
        destination=destination,
        currency="USD",
        start="2026-08-19",
        end="2027-07-15",
        prices=[CalendarPrice(departure_date=day, price=price) for day, price in prices],
    )
