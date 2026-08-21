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
import re
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


# --- reading the year back out of several curves -----------------------------
#
# `FareCalendar.horizon` against the shapes the collector actually produces. The
# fault each one names is the fault, not the function: a chart that lost five
# months the archive still held is what any of these failing would mean.


def window(captured_at: str, start: str, end: str, *, prices) -> CalendarCurve:
    """A curve that states its own window, which is what makes 12.154 legible."""
    return CalendarCurve(
        captured_at=captured_at,
        source="google-flights",
        origin="LIM",
        destination="CUZ",
        currency="USD",
        start=start,
        end=end,
        prices=[CalendarPrice(departure_date=day, price=price) for day, price in prices],
    )


def test_the_far_end_survives_a_curve_that_stopped_short(tmp_path):
    """
    The fault the owner saw: a refusal today took months off the chart.

    Yesterday priced the year to July. Today the provider refused the far window
    and the collector walked its end back to February — honest on disk, and it
    used to be the whole answer, so five months of departure dates left the
    chart while the longer curve sat beside it in the same file.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-20T12:00:00+00:00",
            "2026-08-20",
            "2027-07-16",
            prices=[("2026-09-01", 120.0), ("2027-03-01", 300.0), ("2027-07-01", 410.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [(point.departure_date, point.price) for point in horizon.prices] == [
        ("2026-09-01", 118.0),
        ("2027-03-01", 300.0),
        ("2027-07-01", 410.0),
    ]
    # The far end is still reachable, and the near end has moved on with the
    # newest curve rather than reaching back to a departure that has gone.
    assert (horizon.start, horizon.end) == ("2026-08-21", "2027-07-16")


def test_an_inherited_price_says_when_it_was_seen_rather_than_passing_for_today(tmp_path):
    """
    The quiet lie this merge would otherwise tell.

    A price carried over from an older curve is on screen beside one collected
    minutes ago. Without a stamp of its own the reader has no way to tell them
    apart, and a three-day-old fare reads as today's.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-18T09:00:00+00:00",
            "2026-08-18",
            "2027-07-14",
            prices=[("2026-09-01", 120.0), ("2027-06-01", 400.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    stamps = {point.departure_date: point.observed_at for point in horizon.prices}
    assert stamps["2026-09-01"] == "2026-08-21T12:00:00+00:00"
    assert stamps["2027-06-01"] == "2026-08-18T09:00:00+00:00"
    # And the answer's own stamp is the freshest thing in it, never spread over
    # the June price three days behind it.
    assert horizon.captured_at == "2026-08-21T12:00:00+00:00"


def test_a_date_with_no_flights_is_not_overwritten_by_an_older_price(tmp_path):
    """
    12.154, surviving the merge: answered-and-empty beats never-answered.

    The provider answered about 2026-09-02 today and had nothing to sell, which
    is a real answer and the newest one. Merging on "is the price null" instead
    of "did this curve answer" would have filled it from last week and invented
    a fare out of two true facts.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-18T09:00:00+00:00",
            "2026-08-18",
            "2027-07-14",
            prices=[("2026-09-02", 150.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-02", None)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [(point.departure_date, point.price) for point in horizon.prices] == [
        ("2026-09-02", None)
    ]
    assert horizon.prices[0].observed_at == "2026-08-21T12:00:00+00:00"


def test_a_date_no_curve_ever_answered_for_stays_absent(tmp_path):
    """
    The other half of 12.154: a gap in our collection is still a gap.

    2027-01-01 is inside the merged window and no curve holds it, so it must not
    appear at all. A merge that filled every date in the window with a `null`
    would turn "nobody looked" into "nothing flies", which is the absence the
    window exists to keep separate.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-20T12:00:00+00:00",
            "2026-08-20",
            "2027-07-16",
            prices=[("2026-09-01", 120.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0), ("2027-02-01", 260.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [point.departure_date for point in horizon.prices] == ["2026-09-01", "2027-02-01"]
    # Inside the window and answered for by nobody, which the window is what
    # makes readable.
    assert horizon.start <= "2027-01-01" <= horizon.end


def test_a_departure_that_has_already_gone_is_not_carried_forward(tmp_path):
    """
    The near end moves for a different reason than the far end, and is not repaired.

    A window starts at today, so an older curve reaches back to departures that
    have since happened. Inheriting those would put unbookable flights on the
    chart and would grow this answer by a date a day forever.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-18T09:00:00+00:00",
            "2026-08-18",
            "2027-07-14",
            prices=[("2026-08-18", 80.0), ("2026-09-01", 120.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [point.departure_date for point in horizon.prices] == ["2026-09-01"]
    assert horizon.start == "2026-08-21"


def test_three_curves_are_read_newest_first_rather_than_last_writer_wins(tmp_path):
    """
    Order is by `capturedAt`, not by position in the file, and each date is
    settled by the newest curve that answered for it — not by the newest curve
    that answered for anything.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-19T09:00:00+00:00",
            "2026-08-19",
            "2027-07-15",
            prices=[("2026-09-01", 130.0), ("2027-05-01", 350.0), ("2027-07-10", 500.0)],
        )
    )
    store.append(
        window(
            "2026-08-20T09:00:00+00:00",
            "2026-08-20",
            "2027-07-16",
            prices=[("2026-09-01", 125.0), ("2027-05-01", 345.0)],
        )
    )
    store.append(
        window(
            "2026-08-21T09:00:00+00:00",
            "2026-08-21",
            "2027-07-17",
            prices=[("2026-09-01", 118.0)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert [(point.departure_date, point.price, point.observed_at) for point in horizon.prices] == [
        ("2026-09-01", 118.0, "2026-08-21T09:00:00+00:00"),
        ("2027-05-01", 345.0, "2026-08-20T09:00:00+00:00"),
        ("2027-07-10", 500.0, "2026-08-19T09:00:00+00:00"),
    ]


def test_one_curve_reads_back_as_itself(tmp_path):
    """
    The ordinary case, which is most of them: nothing to merge, nothing changed.

    Worth pinning because the merge is the only path now, so a pair collected
    once has to come back exactly as it went in — every price stamped with the
    one capture time, and the window untouched.
    """
    store = FareCalendar(tmp_path)
    store.append(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0), ("2026-09-02", None)],
        )
    )

    horizon = store.horizon("LIM", "CUZ")
    assert horizon is not None
    assert horizon.captured_at == "2026-08-21T12:00:00+00:00"
    assert (horizon.start, horizon.end) == ("2026-08-21", "2027-07-16")
    assert all(point.observed_at == horizon.captured_at for point in horizon.prices)
    assert [(point.departure_date, point.price) for point in horizon.prices] == [
        ("2026-09-01", 118.0),
        ("2026-09-02", None),
    ]


def test_a_pair_with_no_curves_has_no_horizon(tmp_path):
    assert FareCalendar(tmp_path).horizon("LIM", "CUZ") is None


def test_nothing_is_merged_on_the_way_in(tmp_path):
    """
    The archive stays a record of what was observed when.

    A short curve after a long one is stored short. If a write ever started
    merging, the file would stop being able to answer "what did we see that
    day", and no later reader could separate the two again.
    """
    store = FareCalendar(tmp_path)
    store.append_if_changed(
        window(
            "2026-08-20T12:00:00+00:00",
            "2026-08-20",
            "2027-07-16",
            prices=[("2026-09-01", 120.0), ("2027-07-01", 410.0)],
        )
    )
    store.append_if_changed(
        window(
            "2026-08-21T12:00:00+00:00",
            "2026-08-21",
            "2027-07-16",
            prices=[("2026-09-01", 118.0)],
        )
    )

    stored = store.read("LIM", "CUZ")
    assert [len(curve.prices) for curve in stored] == [2, 1]
    assert stored[-1].prices[0].departure_date == "2026-09-01"


# --- the endpoint ------------------------------------------------------------


def test_the_calendar_endpoint_serves_the_horizon_and_its_health(monkeypatch, tmp_path):
    store = FareCalendar(tmp_path)
    store.append(curve("2026-08-18T12:00:00+00:00", prices=[("2026-12-09", 90.0)]))
    store.append(
        curve("2026-08-19T12:00:00+00:00", prices=[("2026-12-09", 59.87), ("2026-12-10", None)])
    )
    store.record_check("LIM", "CUZ", at="2026-08-19T12:00:00+00:00", outcome="changed", dates=2)
    monkeypatch.setattr(fares_router, "CALENDAR", store)

    answer = TestClient(app).get("/api/fares/calendar?origin=lim&destination=cuz").json()
    assert answer["horizon"]["capturedAt"] == "2026-08-19T12:00:00+00:00"
    # Yesterday's 90.00 is superseded rather than blended: the newer curve
    # answered for that date, so it wins outright and says when it was seen.
    assert answer["horizon"]["prices"] == [
        {
            "departureDate": "2026-12-09",
            "price": 59.87,
            "observedAt": "2026-08-19T12:00:00+00:00",
        },
        {
            "departureDate": "2026-12-10",
            "price": None,
            "observedAt": "2026-08-19T12:00:00+00:00",
        },
    ]
    assert answer["horizon"]["fromDate"] == "2026-08-19"
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
    assert answer.json()["horizon"] is None
    assert answer.json()["health"]["checks"] == 0


def test_a_far_end_the_provider_will_not_price_is_walked_back_rather_than_lost(tmp_path):
    """
    The horizon is a date the provider prices up to, and it moves one day closer
    every day until they extend their schedule.

    Measured 2026-08-20: a window ending +330 days out was refused and the same
    window ending +329 answered in full, while the day before that +330 had
    answered — so `MAX_DEPARTURE_HORIZON_DAYS` was correct when it was measured
    and wrong the next morning. A collector that reported the refusal and gave
    up would lose the whole curve for the sake of one day at its far end, every
    day, and the archive would simply stop growing.
    """
    page = read_fixture(CAPTURE)
    store = FareCalendar(tmp_path)
    asked: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode("utf-8")
        window = re.findall(r"\d{4}-\d{2}-\d{2}", body)[-2:]
        asked.append((window[0], window[1]))
        # Refuse anything reaching past the date this provider will price.
        if window[1] > "2027-07-15":
            return httpx.Response(200, text=read_fixture(REFUSAL))
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("ARI", "SCL", "2027-03")],
                now=datetime(2026, 8, 20, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.failed == 0, "a far end one day out of reach must not fail the curve"
    # The second window asks to 2027-07-16, is refused, and is asked again one
    # day shorter. Three requests: the first window, the refusal, the retry.
    assert [end for _, end in asked] == ["2027-02-16", "2027-07-16", "2027-07-15"]
    assert report.requests == 3


def test_a_pass_that_retries_says_so_while_it_is_still_running(tmp_path):
    """
    The twenty seconds a reader used to sit through with one unchanging sentence.

    This is the same pass as the test above — two windows, one refused and asked
    again — watched through a `CalendarObserver` rather than by its report. The
    plan settles before any request goes out, so a bar has a denominator from
    the start; requests move ahead of windows priced, which is what makes the
    retry visible as work rather than as a machine that has stopped.
    """
    page = read_fixture(CAPTURE)
    store = FareCalendar(tmp_path)
    seen: list[tuple[str, int, int, int]] = []

    class Recorder:
        def __init__(self) -> None:
            self.windows: int | None = None
            self.requests = 0
            self.priced_windows = 0
            self.dates = 0

        def _note(self, what: str) -> None:
            seen.append((what, self.requests, self.priced_windows, self.dates))

        def planned(self, *, windows: int, skipped: list[tuple[str, str]]) -> None:
            self.windows = windows
            self._note("planned")

        def requested(self) -> None:
            self.requests += 1
            self._note("requested")

        def priced(self, *, dates: int) -> None:
            self.priced_windows += 1
            self.dates += dates
            self._note("priced")

    watcher = Recorder()

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode("utf-8")
        window = re.findall(r"\d{4}-\d{2}-\d{2}", body)[-2:]
        if window[1] > "2027-07-15":
            return httpx.Response(200, text=read_fixture(REFUSAL))
        return httpx.Response(200, text=page)

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("ARI", "SCL", "2027-03")],
                now=datetime(2026, 8, 20, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
                observer=watcher,
            )

    asyncio.run(run())

    # The denominator lands first and before a single request, so nothing ever
    # draws a bar against a total it has not been told.
    assert seen[0][0] == "planned"
    assert watcher.windows == 2
    # Three requests for two windows. The pass says both numbers because they
    # are different facts, and the retry is the whole reason they differ.
    assert watcher.requests == 3
    assert watcher.priced_windows == 2
    assert watcher.dates > 0
    # And it moved while it ran rather than all at the end: by the time the
    # second window was priced the reader had already been told about the
    # refused attempt.
    assert [what for what, *_ in seen] == [
        "planned",
        "requested",
        "priced",
        "requested",
        "requested",
        "priced",
    ]


def test_a_pass_with_nothing_due_settles_at_zero_rather_than_staying_unsettled(tmp_path):
    """
    Zero windows and "not settled yet" are different facts and read differently.

    A bar drawn at zero for a plan that has not landed claims a denominator
    nobody has; a bar that never appears for a pass with nothing to do is
    correct. The observer has to be able to say which, so `planned` fires even
    when it has nothing to announce.
    """
    store = FareCalendar(tmp_path)
    store.record_check("LIM", "CUZ", at="2026-08-20T11:00:00+00:00", outcome="unchanged", dates=331)
    announced: list[int] = []

    class Recorder:
        def planned(self, *, windows: int, skipped: list[tuple[str, str]]) -> None:
            announced.append(windows)

        def requested(self) -> None:
            raise AssertionError("a pair that is not due must cost no requests")

        def priced(self, *, dates: int) -> None:
            raise AssertionError("a pair that is not due prices no windows")

    def handler(request: httpx.Request) -> httpx.Response:
        raise AssertionError("nothing was due, so nothing should be asked")

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("LIM", "CUZ", "2027-03")],
                now=datetime(2026, 8, 20, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
                observer=Recorder(),
            )

    report = asyncio.run(run())
    assert announced == [0]
    assert report.skipped == [("LIM-CUZ", "not-due")]


def test_a_refusal_that_is_not_about_the_range_is_reported_rather_than_retried(tmp_path):
    """
    Only `range-refused` is answered by asking for less. A parse failure or a
    consent page does not become an answer by being asked again, and 12.4 wants
    those loud — a retry loop around them would turn one clear alarm into a
    handful of quiet ones.
    """
    store = FareCalendar(tmp_path)
    asked = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal asked
        asked += 1
        return httpx.Response(500, text="upstream fell over")

    async def run():
        async with transport(handler) as client:
            return await collect_calendars(
                [FareWatch("ARI", "SCL", "2027-03")],
                now=datetime(2026, 8, 20, 12, 0, tzinfo=UTC),
                calendar=store,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.failed == 1
    assert asked == 1, "a refusal that is not about the range is asked exactly once"
