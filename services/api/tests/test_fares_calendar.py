"""
The other eleven months, tested without a network.

A watched month is collected board by board and is the reader's primary data.
Every remaining month out to the booking horizon is collected here instead, as
one cheapest fare per departure date, from an endpoint that is undocumented
even by the standards of the one beside it: the request is a positional array
with no field names, so a renumbering does not fail — it asks a different
question and gets a plausible answer back.

So the request is pinned byte for byte against one observed working on
2026-08-19, the parser is pinned against the response it returned, and the case
that matters most has its own test: zero dates where a whole range was expected
is a typed error and never an empty list, because an empty list here reads as
"nothing flies anywhere for eleven months".

Its own file rather than more of `test_fares.py`, which is already 670 lines
about a different unit of observation.
"""

import asyncio
import json
import logging
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.adapters.fares import google_flights
from app.adapters.fares.models import CalendarPrice, CalendarQuery, FareError
from app.main import app
from app.routers import fares as fares_router
from app.services.fare_calendar import CalendarCurve, FareCalendar
from app.services.fare_collector import FareWatch, calendar_windows, collect_calendars
from app.services.fare_history import FareHistory

FIXTURES = Path(__file__).parent / "fixtures"

#: A real answer, captured live on 2026-08-19: LIM-CUZ, the twenty-one
#: departure dates from 2026-12-09 to 2026-12-29. Kept verbatim — `.prettierignore`
#: excludes this directory precisely so nothing reformats the bytes the
#: positions below are pinned against.
CAPTURE = "google_flights_calendar_lim_cuz.txt"

#: The same endpoint refusing. Asking for the whole 331-date horizon in one
#: request answered HTTP 200 with gRPC status 3 where the payload goes.
REFUSAL = "google_flights_calendar_refused.txt"


def read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def graph(name: str = CAPTURE):
    return google_flights._graph_data(google_flights._rpc_frames(read_fixture(name)))


def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


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
    assert caught.value.code == "upstream-error"
    assert "too wide" in caught.value.message


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


# --- the store ---------------------------------------------------------------


def test_a_curve_round_trips_through_the_store(tmp_path):
    store = FareCalendar(tmp_path)
    store.append(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))

    read = store.read("LIM", "CUZ")
    assert len(read) == 1
    assert [(p.departure_date, p.price) for p in read[0].prices] == [("2026-12-09", 59.87)]
    assert (read[0].start, read[0].end) == ("2026-08-19", "2027-07-15")


def test_a_day_with_no_flights_survives_the_round_trip_as_a_null(tmp_path):
    """
    Written as `null`, read back as `None`, and never as a zero.

    A zero would draw a free flight; dropping the key would lose the difference
    between a day nobody flies and a day the collection never reached.
    """
    store = FareCalendar(tmp_path)
    store.append(
        curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", None), ("2026-12-10", 60.0)])
    )
    read = store.read("LIM", "CUZ")[0]
    assert [(p.departure_date, p.price) for p in read.prices] == [
        ("2026-12-09", None),
        ("2026-12-10", 60.0),
    ]
    assert read.cheapest.price == 60.0


def test_the_window_asked_for_is_stored_beside_the_prices(tmp_path):
    """
    Which is what makes a missing date readable as a gap rather than as a date
    nobody wanted. Without `from` and `to` the file cannot say the difference.
    """
    store = FareCalendar(tmp_path)
    store.append(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))
    row = json.loads((tmp_path / "LIM-CUZ.jsonl").read_text(encoding="utf-8"))
    assert row["from"] == "2026-08-19" and row["to"] == "2027-07-15"
    assert row["prices"] == {"2026-12-09": 59.87}


def test_an_unchanged_curve_is_not_written_a_second_time(tmp_path):
    """
    Measured on the first real curve — ARI-SCL, 331 dates, 7,145 bytes — a
    by-the-clock daily write is 2.6 MB a route a year of lines that mostly say
    nothing. Same rule as 12.16, one level up from a board.
    """
    store = FareCalendar(tmp_path)
    same = [("2026-12-09", 59.87), ("2026-12-10", 60.0)]
    assert store.append_if_changed(curve("2026-08-19T12:00:00+00:00", prices=same)) is True
    assert store.append_if_changed(curve("2026-08-20T12:00:00+00:00", prices=same)) is False
    assert len(store.read("LIM", "CUZ")) == 1

    moved = [("2026-12-09", 59.87), ("2026-12-10", 71.0)]
    assert store.append_if_changed(curve("2026-08-21T12:00:00+00:00", prices=moved)) is True
    assert len(store.read("LIM", "CUZ")) == 2


def test_a_day_losing_its_last_flight_counts_as_the_curve_changing(tmp_path):
    """A price going away is news, and a fingerprint that ignored it would hide it."""
    store = FareCalendar(tmp_path)
    store.append_if_changed(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))
    assert (
        store.append_if_changed(curve("2026-08-20T12:00:00+00:00", prices=[("2026-12-09", None)]))
        is True
    )


def test_the_curves_live_beside_the_boards_and_not_among_them(tmp_path):
    """
    Why this is not a fifth kind of file inside `FareHistory` — the reason is
    `last_checked()`, which is the board scheduler's own input and reads that
    directory. A curve is keyed by `capturedAt` where every file there is keyed
    by `flightDate`, and the board collection is not touched by this feature.
    """
    from app.adapters.fares.models import FareSnapshot

    history = FareHistory(tmp_path)
    history.append(
        FareSnapshot(
            captured_at="2026-08-19T12:00:00+00:00",
            source="google-flights",
            origin="LIM",
            destination="CUZ",
            flight_date="2027-03-09",
            return_date=None,
            currency="USD",
            offers=[],
        )
    )
    store = FareCalendar(tmp_path / "calendar")
    store.append(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))

    assert [path.name for path in sorted(tmp_path.glob("*.jsonl"))] == ["LIM-CUZ.jsonl"]
    assert history.last_checked() == {}
    assert history.read("LIM", "CUZ")[0].flight_date == "2027-03-09"
    assert len(store.read("LIM", "CUZ")) == 1


def test_a_hostile_route_code_cannot_escape_the_calendar_directory(tmp_path):
    """The one guard that must never be a second copy: `route_stem` is imported."""
    store = FareCalendar(tmp_path)
    store.append(
        curve("2026-08-19T12:00:00+00:00", prices=[], origin="../../etc", destination="p/w")
    )
    written = list(tmp_path.rglob("*.jsonl"))
    assert len(written) == 1
    assert written[0].parent == tmp_path


def test_a_corrupt_curve_costs_that_line_and_nothing_else(tmp_path):
    store = FareCalendar(tmp_path)
    store.append(curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87)]))
    with (tmp_path / "LIM-CUZ.jsonl").open("a", encoding="utf-8") as handle:
        handle.write("{ not json\n")
    store.append(curve("2026-08-20T12:00:00+00:00", prices=[("2026-12-09", 60.0)]))
    assert len(store.read("LIM", "CUZ")) == 2


def test_a_calendar_file_nobody_can_read_is_an_error_not_a_warning(tmp_path, caplog):
    """One bad line is a bad line; every bad line is a format change."""
    (tmp_path / "LIM-CUZ.jsonl").write_text('{"nope": 1}\n{"also": 2}\n', encoding="utf-8")
    with caplog.at_level(logging.ERROR):
        assert FareCalendar(tmp_path).read("LIM", "CUZ") == []
    assert "format has probably changed" in caplog.text


def test_the_store_decides_what_is_stale(tmp_path):
    """
    The collector asks and does not remember. Same division `due_now` and
    `last_checked` already draw for the boards.
    """
    store = FareCalendar(tmp_path)
    now = datetime(2026, 8, 19, 12, 0, tzinfo=UTC)
    assert store.due("LIM", "CUZ", now, every_minutes=1440) is True

    store.record_check("LIM", "CUZ", at="2026-08-19T06:00:00+00:00", outcome="unchanged")
    assert store.due("LIM", "CUZ", now, every_minutes=1440) is False
    assert store.due("LIM", "CUZ", now, every_minutes=60) is True


# --- the pass ----------------------------------------------------------------


def test_two_windows_cover_the_horizon_and_neither_repeats_a_date():
    """
    Measured 2026-08-19: a 181-date window answered in full and the whole
    331-date horizon was refused, so the horizon is two requests and cannot be
    one. They are contiguous rather than overlapping — a departure returned
    twice would be stored twice under one key and the later answer would
    silently win.
    """
    windows = calendar_windows(datetime(2026, 8, 19, 12, 0, tzinfo=UTC))
    assert windows == [("2026-08-19", "2027-02-15"), ("2027-02-16", "2027-07-15")]

    first, second = windows
    assert date.fromisoformat(second[0]) - date.fromisoformat(first[1]) == timedelta(days=1)
    assert date.fromisoformat(second[1]) - date.fromisoformat(first[0]) == timedelta(days=330)


def test_a_narrower_provider_limit_costs_more_windows_and_not_less_horizon():
    """The horizon is the fixed thing; the window width is whoever answered."""
    windows = calendar_windows(
        datetime(2026, 8, 19, 12, 0, tzinfo=UTC), horizon_days=330, width_days=60
    )
    assert len(windows) == 6
    assert windows[0][0] == "2026-08-19"
    assert windows[-1][1] == "2027-07-15"


def test_a_pass_spends_two_requests_a_city_pair_and_stores_one_curve(tmp_path):
    """
    Two watched months on one pair are one collection: a curve covers every
    month at once, so the month somebody watches is not a key here.
    """
    page = read_fixture(CAPTURE)
    store = FareCalendar(tmp_path)
    asked: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        asked.append(request.content.decode("utf-8"))
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [
                    FareWatch("LIM", "CUZ", "2027-03"),
                    FareWatch("LIM", "CUZ", "2027-04"),
                    FareWatch("ARI", "SCL", "2027-03"),
                ],
                now=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert len(report.results) == 2
    assert report.requests == 4
    assert len(asked) == 4
    assert len(store.read("LIM", "CUZ")) == 1
    assert len(store.read("ARI", "SCL")) == 1
    # Both windows are answered with the same fixture here, which is a shape the
    # contiguous windows cannot produce live — and it is worth pinning that the
    # report counts what the archive holds rather than what arrived, because the
    # stored row is a map keyed by date and would collapse the repeat in silence.
    assert report.results[0].dates == 21
    assert len(store.read("LIM", "CUZ")[0].prices) == 21
    assert report.results[0].cheapest == 40.97
    assert report.results[0].cheapest_on == "2026-12-18"


def test_a_route_looked_at_today_is_skipped_with_a_reason_rather_than_dropped(tmp_path):
    """8.8 and 8.41: a pass that silently skips a route reads like a healthy one."""
    store = FareCalendar(tmp_path)
    store.record_check("LIM", "CUZ", at="2026-08-19T06:00:00+00:00", outcome="unchanged")

    async def run():
        async with transport(lambda request: httpx.Response(500)) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03")],
                now=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.results == []
    assert report.skipped == [("LIM-CUZ", "not-due")]


def test_one_window_refusing_costs_the_whole_curve_rather_than_half_of_it(tmp_path):
    """
    Two windows are one observation of one year. Storing the half that answered
    would put a curve in the archive that stops in February for a reason the
    file does not record — the quiet partial answer 12.4 exists to forbid.
    """
    page = read_fixture(CAPTURE)
    store = FareCalendar(tmp_path)
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(200, text=page) if calls["n"] == 1 else httpx.Response(429)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03")],
                now=datetime(2026, 8, 19, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.failed == 1
    assert report.results[0].error_code == "rate-limited"
    assert store.read("LIM", "CUZ") == []
    # The heartbeat is still written, so the gap is a recorded failure rather
    # than a stretch nobody can account for.
    assert [row["outcome"] for row in store.checks("LIM", "CUZ")] == ["error"]


# --- the endpoint ------------------------------------------------------------


def test_the_calendar_endpoint_serves_the_latest_curve_and_its_health(monkeypatch, tmp_path):
    store = FareCalendar(tmp_path)
    store.append(curve("2026-08-18T12:00:00+00:00", prices=[("2026-12-09", 90.0)]))
    store.append(
        curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87), ("2026-12-10", None)])
    )
    store.record_check("LIM", "CUZ", at="2026-08-19T12:00:00+00:00", outcome="changed", dates=2)
    monkeypatch.setattr(fares_router, "CALENDAR", store)

    answer = TestClient(app).get("/api/fares/calendar?origin=lim&destination=cuz").json()
    assert answer["latest"]["capturedAt"] == "2026-08-19T12:00:00+00:00"
    assert answer["latest"]["prices"] == [
        {"departureDate": "2026-12-09", "price": 59.87},
        {"departureDate": "2026-12-10", "price": None},
    ]
    assert answer["latest"]["fromDate"] == "2026-08-19"
    assert answer["health"] == {
        "lastCheckedAt": "2026-08-19T12:00:00+00:00",
        "checks": 1,
        "changes": 1,
        "errors": 0,
    }


def test_a_city_pair_nobody_has_collected_answers_null_rather_than_a_404(monkeypatch, tmp_path):
    """
    A route added a minute ago has no curve yet, and that is not an error: the
    client draws nothing and the health block says nothing has looked.
    """
    monkeypatch.setattr(fares_router, "CALENDAR", FareCalendar(tmp_path))
    answer = TestClient(app).get("/api/fares/calendar?origin=LIM&destination=MAD")
    assert answer.status_code == 200
    assert answer.json()["latest"] is None
    assert answer.json()["health"]["checks"] == 0
