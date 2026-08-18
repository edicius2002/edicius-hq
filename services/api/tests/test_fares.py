"""
The airfare plane, tested without a network.

The Google Flights adapter is a scraper of an untagged array, so its parsing is
pinned against a captured fixture: every index it depends on is a position that
a Google refactor renumbers silently. These tests are the alarm for that.

The rest is the archive and the collector, both of which must keep their
promises when a provider refuses — that is most of what they are for.
"""

import asyncio
import base64
import json
import logging
from pathlib import Path

import httpx
import pytest

from app.adapters import wire
from app.adapters.fares import google_flights
from app.adapters.fares.models import FareError, FareOffer, FareQuery, FareSnapshot
from app.services.fare_collector import collect
from app.services.fare_history import FareHistory

FIXTURES = Path(__file__).parent / "fixtures"


def read_fixture(name: str) -> str:
    return (FIXTURES / name).read_text(encoding="utf-8")


def offer(price: float, *, airline: str = "LA", departure: str = "2026-10-16T08:00") -> FareOffer:
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


# --- protobuf writer -------------------------------------------------------


def test_varint_matches_the_spec_examples():
    assert wire.write_varint(1) == b"\x01"
    assert wire.write_varint(150) == b"\x96\x01"
    assert wire.write_varint(300) == b"\xac\x02"


def test_writer_round_trips_through_the_reader():
    """The two halves of `wire` must agree, or one of them is wrong."""
    message = wire.write_string(2, "LIM") + wire.write_varint_field(9, 1)
    fields = wire.read_message(message)
    assert wire.as_text(fields[2]) == "LIM"
    assert fields[9] == 1


def test_writer_refuses_a_negative_varint():
    with pytest.raises(wire.WireError):
        wire.write_varint(-1)


# --- tfs query building ----------------------------------------------------


def test_one_way_tfs_is_stable():
    """
    Pinned against a value captured from a working request on 2026-08-17.

    If this changes, every collected route silently starts searching for
    something other than what was asked for — which no other test would catch,
    because a wrong-but-valid query still returns flights.
    """
    tfs = google_flights.build_tfs(FareQuery("LIM", "SCL", "2026-10-16"))
    assert tfs == "GhoSCjIwMjYtMTAtMTZqBRIDTElNcgUSA1NDTEIBAUgBmAEC"


def test_round_trip_tfs_carries_both_legs_and_flips_the_trip_type():
    one_way = google_flights.build_tfs(FareQuery("LIM", "SCL", "2026-10-16"))
    returning = google_flights.build_tfs(
        FareQuery("LIM", "SCL", "2026-10-16", return_date="2026-10-23")
    )
    assert returning != one_way
    decoded = base64.b64decode(returning).decode("latin-1")
    assert "2026-10-23" in decoded
    assert decoded.count("SCL") == 2  # destination out, origin back


def test_airport_codes_are_normalised_into_the_query():
    lower = google_flights.build_tfs(FareQuery(" lim ", "scl", "2026-10-16"))
    upper = google_flights.build_tfs(FareQuery("LIM", "SCL", "2026-10-16"))
    assert lower == upper


# --- payload parsing -------------------------------------------------------


def test_fixture_parses_into_offers_with_airline_and_departure_time():
    html = read_fixture("google_flights_lim_scl.html")
    offers = google_flights.parse_payload(google_flights.extract_payload(html), "USD")

    assert [o.price for o in offers] == [125.0, 125.0]
    first = offers[0]
    assert first.airline == "LA"
    assert first.airline_name == "LATAM"
    assert first.flight_number == "529"
    assert first.transfers == 0
    assert first.duration_minutes == 215
    assert first.currency == "USD"


def test_a_midnight_departure_is_not_read_as_noon():
    """
    Google omits zeroes, so `[None, 15]` is 00:15 and `[11]` is 11:00.

    The captured itinerary leaves at 00:15. Reading the missing hour as
    anything but nought moves a red-eye into the middle of the day, which is
    wrong in a way a chart would never make obvious.
    """
    html = read_fixture("google_flights_lim_scl.html")
    offers = google_flights.parse_payload(google_flights.extract_payload(html), "USD")
    assert offers[0].departure_at == "2026-10-16T00:15"
    assert offers[0].arrival_at == "2026-10-16T05:50"


def test_offers_come_back_cheapest_first():
    html = read_fixture("google_flights_lim_scl.html")
    offers = google_flights.parse_payload(google_flights.extract_payload(html), "USD")
    assert offers == sorted(offers, key=lambda o: o.price)


def test_a_page_without_the_data_block_is_unreadable_not_empty():
    with pytest.raises(FareError) as caught:
        google_flights.extract_payload("<html><body>consent</body></html>")
    assert caught.value.code == "unreadable"


def test_google_reporting_no_itineraries_is_its_own_code():
    payload = [None, None, None, [None], None, None, None, None]
    with pytest.raises(FareError) as caught:
        google_flights.parse_payload(payload, "USD")
    assert caught.value.code == "no-offers"


def test_itineraries_we_can_no_longer_read_raise_drift_rather_than_returning_none():
    """
    The whole reason this adapter is allowed to exist.

    A layout change makes every itinerary unreadable, and the natural result of
    a defensive parser is an empty list — indistinguishable from a quiet day on
    a route. It has to be loud instead.
    """
    payload = [None, None, None, [[["nonsense"], ["also nonsense"]]], None, None, None, None]
    with pytest.raises(FareError) as caught:
        google_flights.parse_payload(payload, "USD")
    assert caught.value.code == "parse-drift"


def test_one_bad_itinerary_does_not_cost_the_good_ones():
    html = read_fixture("google_flights_lim_scl.html")
    payload = google_flights.extract_payload(html)
    payload[3][0].append(["broken"])
    offers = google_flights.parse_payload(payload, "USD")
    assert len(offers) == 2


# --- the archive -----------------------------------------------------------


def test_append_then_read_round_trips_a_snapshot(tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0, 180.0]))

    read = history.read("LIM", "SCL")
    assert len(read) == 1
    assert read[0].captured_at == "2026-08-17T12:00:00+00:00"
    assert [o.price for o in read[0].offers] == [125.0, 180.0]
    assert read[0].cheapest.price == 125.0


def test_a_second_append_adds_a_line_rather_than_overwriting(tmp_path):
    """The difference from `BarCache` that this store exists for."""
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    history.append(snapshot("2026-08-18T12:00:00+00:00", prices=[139.0]))

    read = history.read("LIM", "SCL")
    assert [s.captured_at for s in read] == [
        "2026-08-17T12:00:00+00:00",
        "2026-08-18T12:00:00+00:00",
    ]


def test_history_is_returned_oldest_first_whatever_order_it_was_written(tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-19T12:00:00+00:00", prices=[150.0]))
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))

    assert [s.captured_at[:10] for s in history.read("LIM", "SCL")] == [
        "2026-08-17",
        "2026-08-19",
    ]


def test_since_and_until_filter_on_when_the_price_was_observed(tmp_path):
    history = FareHistory(tmp_path)
    for day in ("16", "17", "18"):
        history.append(snapshot(f"2026-08-{day}T12:00:00+00:00", prices=[125.0]))

    windowed = history.read("LIM", "SCL", since="2026-08-17", until="2026-08-17T23")
    assert [s.captured_at[:10] for s in windowed] == ["2026-08-17"]


def test_a_corrupt_line_costs_that_line_and_nothing_else(tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    path = tmp_path / "LIM-SCL.jsonl"
    with path.open("a", encoding="utf-8") as handle:
        handle.write("{ this is not json\n")
    history.append(snapshot("2026-08-18T12:00:00+00:00", prices=[139.0]))

    read = history.read("LIM", "SCL")
    assert len(read) == 2


def test_an_archive_nobody_can_read_is_logged_as_an_error_not_a_warning(tmp_path, caplog):
    """
    One bad line is a bad line; every bad line is a format change.

    Found in development — renaming the offer keys made a two-line archive read
    as no history at all, and the only trace was a `warning` beside an empty
    chart. That is the same silent shape `parse-drift` exists to prevent.
    """
    path = tmp_path / "LIM-SCL.jsonl"
    path.write_text('{"nope": 1}\n{"also": 2}\n', encoding="utf-8")

    with caplog.at_level(logging.ERROR):
        assert FareHistory(tmp_path).read("LIM", "SCL") == []
    assert "format has probably changed" in caplog.text


def test_a_route_with_no_file_reads_as_empty_rather_than_raising(tmp_path):
    assert FareHistory(tmp_path).read("LIM", "MAD") == []


def test_a_hostile_route_code_cannot_escape_the_directory(tmp_path):
    history = FareHistory(tmp_path)
    history.append(
        FareSnapshot(
            captured_at="2026-08-17T12:00:00+00:00",
            source="google-flights",
            origin="../../etc",
            destination="pa/sswd",
            flight_date="2026-10-16",
            return_date=None,
            currency="USD",
            offers=[],
        )
    )
    written = list(tmp_path.rglob("*.jsonl"))
    assert len(written) == 1
    assert written[0].parent == tmp_path


def test_routes_lists_what_has_history(tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[600.0], destination="MAD"))
    assert history.routes() == [("LIM", "MAD"), ("LIM", "SCL")]


# --- the collector ---------------------------------------------------------


def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def searched_for(request: httpx.Request) -> str:
    """
    The route a request is asking about.

    For Google Flights it is not in the URL in any readable form — the whole
    search is a base64 protobuf in `?tfs=` — so a handler that wants to answer
    differently per route has to decode it, exactly as Google does.

    Travelpayouts spells the same thing in plain query parameters, and a
    handler has to cope with both: the registry falls back from one to the
    other, so a single handler can be asked the same question twice by two
    different providers.
    """
    tfs = request.url.params.get("tfs")
    if tfs is None:
        return f"{request.url.params.get('origin', '')}-{request.url.params.get('destination', '')}"
    return base64.b64decode(tfs).decode("latin-1")


def test_collect_archives_every_route_it_could_fetch(tmp_path):
    html = read_fixture("google_flights_lim_scl.html")
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=html)) as client:
            return await collect(
                [FareQuery("LIM", "SCL", "2026-10-16"), FareQuery("LIM", "MAD", "2026-10-16")],
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.collected == 2
    assert report.failed == 0
    assert report.results[0].cheapest == 125.0
    assert report.results[0].offers == 2
    assert len(history.read("LIM", "SCL")) == 1
    assert len(history.read("LIM", "MAD")) == 1


def test_a_refused_route_is_reported_beside_the_ones_that_worked(tmp_path):
    """
    Decisions 8.8 and 8.41. A collector that dropped the failure would look
    exactly like a route whose price did not move.
    """
    html = read_fixture("google_flights_lim_scl.html")
    history = FareHistory(tmp_path)

    def handler(request):
        if "VVI" in searched_for(request):
            return httpx.Response(429, text="slow down")
        return httpx.Response(200, text=html)

    async def run():
        async with transport(handler) as client:
            return await collect(
                [FareQuery("LIM", "SCL", "2026-10-16"), FareQuery("LIM", "VVI", "2026-10-16")],
                # No fallback here: this test is about what the collector does
                # with a refusal, and a second provider quietly rescuing the
                # route would test the registry instead. The fallback has its
                # own tests.
                fallback=None,
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.collected == 1
    assert report.failed == 1

    failed = next(result for result in report.results if not result.ok)
    assert failed.destination == "VVI"
    assert failed.error_code == "rate-limited"
    assert failed.error_message
    # Nothing was archived for the route that failed, so the series keeps no
    # phantom point at a price nobody observed.
    assert history.read("LIM", "VVI") == []


def test_collect_reports_a_route_google_has_no_flights_for(tmp_path):
    empty = json.dumps([None, None, None, [None], None, None, None, None])
    page = (
        f'<script class="ds:1">AF_initDataCallback({{data:{empty}, sideChannel: {{}}}});</script>'
    )
    history = FareHistory(tmp_path)

    async def run():
        async with transport(lambda request: httpx.Response(200, text=page)) as client:
            return await collect(
                [FareQuery("LIM", "IPC", "2026-10-16")],
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.results[0].error_code == "no-offers"
    assert history.read("LIM", "IPC") == []
