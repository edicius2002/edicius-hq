"""
The calendar request, and the answer read back out of it.

The other eleven months are collected as one cheapest fare per departure date,
from an endpoint that is undocumented even by the standards of the one beside
it: the request is a positional array with no field names, so a renumbering does
not fail — it asks a different question and gets a plausible answer back.

So the request is pinned byte for byte against one observed working on
2026-08-19, the parser is pinned against the response it returned, and the case
that matters most has its own test: zero dates where a whole range was expected
is a typed error and never an empty list, because an empty list here reads as
"nothing flies anywhere for eleven months".

Out of `test_fares_calendar.py`; the store is in `test_calendar_store.py` and
the pass and endpoint over it in `test_calendar_pass.py`.
"""

import asyncio
import json

import httpx
import pytest
from conftest import CAPTURE, REFUSAL, read_fixture, transport

from app.adapters.fares import google_flights
from app.adapters.fares.models import CalendarQuery, FareError


def graph(name: str = CAPTURE):
    return google_flights._graph_data(google_flights._rpc_frames(read_fixture(name)))


# --- the request -------------------------------------------------------------


def test_the_calendar_request_is_the_shape_captured_from_a_live_page():
    """
    Pinned byte for byte against a request observed working on 2026-08-19.

    Every number in it is a position in an untagged array, so a wrong index does
    not raise — it asks about the wrong route, the wrong dates or the wrong
    cabin and gets a perfectly plausible answer. Nothing else in this file, and
    nothing in the archive, would ever notice.
    """
    built = google_flights.build_calendar_request(
        CalendarQuery("LIM", "CUZ", "2026-12-09", "2026-12-29")
    )
    assert built == (
        '[null,"[null,[null,null,2,null,[],1,[1,0,0,0],null,null,null,null,'
        'null,null,[[[[[\\"LIM\\",0]]],[[[\\"CUZ\\",0]]],null,0,null,null,'
        '\\"2026-12-09\\",null,null,null,null,null,null,null,3]],null,null,'
        'null,1],[\\"2026-12-09\\",\\"2026-12-29\\"]]"]'
    )


def test_the_window_asked_for_is_the_window_that_travels():
    """The one field this endpoint exists for, read back out of the built form."""
    built = google_flights.build_calendar_request(
        CalendarQuery("LIM", "CUZ", "2026-08-19", "2027-02-15")
    )
    assert json.loads(json.loads(built)[1])[2] == ["2026-08-19", "2027-02-15"]


def test_airport_codes_are_normalised_into_the_calendar_request():
    lower = google_flights.build_calendar_request(
        CalendarQuery(" lim ", "cuz", "2026-12-09", "2026-12-29")
    )
    upper = google_flights.build_calendar_request(
        CalendarQuery("LIM", "CUZ", "2026-12-09", "2026-12-29")
    )
    assert lower == upper


# --- the answer --------------------------------------------------------------


def test_the_captured_answer_reads_as_one_cheapest_fare_per_departure_date():
    prices = google_flights.parse_calendar(graph())

    assert len(prices) == 21
    assert prices[0].departure_date == "2026-12-09"
    assert prices[-1].departure_date == "2026-12-29"
    assert all(point.price is not None for point in prices)


def test_the_calendar_price_is_read_to_the_cent_like_an_itinerary_is():
    """
    The token beside the rounded integer is the same token an itinerary carries,
    so `_exact_price` reads it unchanged — which is why this adapter lives in
    the Google Flights module rather than a second one beside it.

    On the capture, twenty of the twenty-one dates display 60 and are really
    59.87, and the last displays 62 against a real 61.05. Rounding merges
    distinct fares, and noticing a fare move is the whole job — 12.15.
    """
    prices = google_flights.parse_calendar(graph())
    assert prices[0].price == 59.87
    assert prices[-1].price == 61.05
    assert graph()[1][0][2][0][1] == 60  # what the page would have printed


def test_an_answer_without_the_guard_is_unreadable_rather_than_empty():
    with pytest.raises(FareError) as caught:
        google_flights._rpc_frames('[["wrb.fr",null,"[]"]]')
    assert caught.value.code == "unreadable"


def test_a_length_prefixed_envelope_reads_the_same_as_a_plain_one():
    """
    Three live answers arrived as the guard and one JSON array. The note this
    was built from recorded a length line, which is how `batchexecute` streams,
    so both are read — losing the feature to a transport detail seen once would
    cost more than the six lines that handle it.
    """
    plain = read_fixture(CAPTURE)
    payload = plain.split("\n", 1)[1].strip()
    chunked = f")]}}'\n{len(payload)}\n{payload}"
    assert google_flights._rpc_frames(chunked) == google_flights._rpc_frames(plain)


def test_a_range_google_refuses_is_upstream_saying_no_and_not_drift():
    """
    What a refusal looks like on the wire, captured live rather than imagined.

    Asking for the whole 331-date horizon in one request came back HTTP 200,
    with the same envelope, the same `wrb.fr` frame, `null` where the payload
    goes and gRPC status 3 — INVALID_ARGUMENT — in its place. A parser that
    called that drift would cry wolf whenever a range was a day too wide, and
    the alarm would stop meaning anything.
    """
    with pytest.raises(FareError) as caught:
        graph(REFUSAL)
    # Its own code rather than the general `upstream-error`, because this is the
    # one refusal a caller can answer — by asking for less. Matching it on the
    # message text would make the retry hinge on a sentence.
    assert caught.value.code == "range-refused"
    assert "further ahead than it will price" in caught.value.message


def test_zero_dates_where_a_whole_range_was_expected_is_drift_not_an_answer():
    """
    Decision 12.4, and the endpoint that needs it most.

    An empty list is exactly what a defensive parser returns when Google
    renumbers its payload, and here it would read as "nothing flies anywhere for
    eleven months" — a claim about the world made by a bug about an array index.
    """
    for shape in ([None, []], [None, None], [None], [], None):
        with pytest.raises(FareError) as caught:
            google_flights.parse_calendar(shape)
        assert caught.value.code == "parse-drift", shape


def test_rows_that_carry_no_departure_date_are_drift():
    """A renumbering that moves the date off position 0 has to be loud."""
    with pytest.raises(FareError) as caught:
        google_flights.parse_calendar([None, [[None, None, [[None, 60], ""], 1]] * 3])
    assert caught.value.code == "parse-drift"


def test_a_day_with_no_flights_is_kept_as_a_null_price_rather_than_dropped():
    """
    A gap in the answer and a day with nothing to sell are different facts.

    Dropping the priceless day would make an unserved Tuesday indistinguishable
    from a window the collection never reached, and this store is built to tell
    those two apart.
    """
    prices = google_flights.parse_calendar(
        [
            None,
            [
                ["2027-01-04", None, [[None, 88], ""], 1],
                ["2027-01-05", None, None, 0],
            ],
        ]
    )
    assert [(p.departure_date, p.price) for p in prices] == [
        ("2027-01-04", 88.0),
        ("2027-01-05", None),
    ]


def test_a_range_where_nothing_flies_on_any_day_is_no_offers_not_drift():
    """Every row had the shape we expect; the city pair simply has no service."""
    rows = [[f"2027-01-{day:02d}", None, None, 0] for day in (4, 5, 6)]
    with pytest.raises(FareError) as caught:
        google_flights.parse_calendar([None, rows])
    assert caught.value.code == "no-offers"


def test_the_adapter_asks_for_a_calendar_without_a_cookie_in_sight():
    """
    The capture came from a signed-in browser and the session turned out not to
    matter: measured live on 2026-08-19, this module's own client with no
    cookies at all was answered in full. This pins that it sends none.
    """
    page = read_fixture(CAPTURE)
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["cookie"] = request.headers.get("cookie")
        seen["body"] = request.content.decode("utf-8")
        seen["currency"] = request.url.params["curr"]
        seen["method"] = request.method
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await google_flights.fetch_calendar(
                client, CalendarQuery("LIM", "CUZ", "2026-12-09", "2026-12-29")
            )

    prices = asyncio.run(run())
    assert len(prices) == 21
    assert seen["cookie"] is None
    assert seen["method"] == "POST"
    assert seen["currency"] == "USD"
    assert str(seen["body"]).startswith("f.req=")


def test_being_rate_limited_is_its_own_code_here_too():
    async def run():
        async with transport(lambda request: httpx.Response(429)) as client:
            return await google_flights.fetch_calendar(
                client, CalendarQuery("LIM", "CUZ", "2026-12-09", "2026-12-29")
            )

    with pytest.raises(FareError) as caught:
        asyncio.run(run())
    assert caught.value.code == "rate-limited"
