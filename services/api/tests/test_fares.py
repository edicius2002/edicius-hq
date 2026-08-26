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
import time
from datetime import datetime, timedelta
from itertools import pairwise
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient

from app.adapters import wire
from app.adapters.fares import google_flights
from app.adapters.fares.models import FareError, FareOffer, FareQuery, FareSnapshot
from app.main import app
from app.routers import fares as fares_router
from app.services import collection_job
from app.services.fare_collector import CollectionReport, FareWatch, RouteResult, collect
from app.services.fare_history import FareHistory

FIXTURES = Path(__file__).parent / "fixtures"


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

    assert [o.price for o in offers] == [124.64, 124.64]
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


def test_the_captured_lim_scl_page_carries_no_best_departing_block_at_all():
    """
    Why that fixture's count did not move when the second block was read.

    `payload[2]` is a literal `null` there, so the board really is the one list
    — which is also the evidence that an absent best-departing block is a shape
    Google sends rather than a renumbering to raise on.
    """
    payload = google_flights.extract_payload(read_fixture("google_flights_lim_scl.html"))
    assert payload[2] is None
    assert len(google_flights.parse_payload(payload, "USD")) == 2


# --- both departing blocks -------------------------------------------------


def test_a_thin_board_loses_more_than_half_of_itself_to_one_block():
    """
    The measurement this fix exists for.

    LIM-MAD on 2026-10-15 puts five itineraries under "Best departing flights"
    and four under everything else. Reading `payload[3]` alone archived four of
    the nine that were on the board, every collection since the feature landed,
    and nothing outside the page could have shown it.
    """
    payload = read_payload("google_flights_lim_mad_payload.json")
    assert len(payload[google_flights._BEST_BLOCK][0]) == 5
    assert len(payload[google_flights._ALL_BLOCK][0]) == 4

    offers = google_flights.parse_payload(payload, "USD")
    assert len(offers) == 9
    prices = sorted(o.price for o in offers)
    assert prices == [602.54, 602.54, 602.54, 626.69, 744.14, 744.14, 744.14, 791.34, 940.19]
    # The cheapest fare happened to be in the block already read, so the
    # headline figure was right and everything shaped stayed wrong: the median
    # of the four archived offers was 767.74 against the board's real 744.14.
    assert prices[len(prices) // 2] == 744.14


def test_two_connections_behind_one_first_leg_both_survive_the_merge():
    """
    Why deduplication is not on (carrier, number, departure).

    AV 50 leaves Lima for Bogota at 11:45 and is on this board twice: once
    continuing to Madrid on AV 182 at 16:25 for 626.69, once on AV 10 at 21:35
    for 602.54. They share a first leg and nothing else, and a merge keyed on
    the first leg would have silently dropped one of them.
    """
    offers = google_flights.parse_payload(
        read_payload("google_flights_lim_mad_payload.json"), "USD"
    )
    av50 = [o for o in offers if o.airline == "AV" and o.flight_number == "50"]
    assert len(av50) == 2
    assert {o.departure_at for o in av50} == {"2026-10-15T11:45"}
    assert {o.arrival_at for o in av50} == {"2026-10-16T09:05", "2026-10-16T14:05"}
    assert {o.price for o in av50} == {602.54, 626.69}


def test_a_wide_board_keeps_every_itinerary_from_both_blocks():
    """
    LIM-CUZ on 2026-09-09: five best-departing and thirty-one others, with no
    itinerary in common. Seven of the 43 rows are Sky Airline flights carrying
    no price at all, which is why 43 rows read as 36 offers — an offer with no
    price is not an observation, and dropping those is behaviour that predates
    this fix.
    """
    payload = read_payload("google_flights_lim_cuz_payload.json")
    assert len(payload[google_flights._BEST_BLOCK][0]) == 6
    assert len(payload[google_flights._ALL_BLOCK][0]) == 37

    offers = google_flights.parse_payload(payload, "USD")
    assert len(offers) == 36
    assert len({(o.airline, o.flight_number, o.departure_at, o.arrival_at) for o in offers}) == 36


def test_an_itinerary_listed_in_both_blocks_is_reported_once():
    """
    Disjointness was observed, not promised.

    It held on the two captured one-way searches and was never checked on a
    round trip or a multi-stop search. A duplicate would move the count, the
    median and the dearest fare all at once, so the merge is built not to
    depend on it.
    """
    payload = read_payload("google_flights_lim_mad_payload.json")
    before = len(google_flights.parse_payload(payload, "USD"))
    payload[google_flights._BEST_BLOCK][0].append(payload[google_flights._ALL_BLOCK][0][0])
    assert len(google_flights.parse_payload(payload, "USD")) == before


def test_the_same_board_reads_the_same_whichever_order_google_sent_it_in():
    """
    Ordering noise must not reach the archive.

    `fingerprint` sorts before hashing, so a reshuffle would not write a
    snapshot — but the stored offer list, the flight table and every figure the
    page prints read the order as given, and thirteen itineraries on the
    LIM-CUZ board share one price.
    """
    payload = read_payload("google_flights_lim_cuz_payload.json")
    straight = google_flights.parse_payload(payload, "USD")

    payload[google_flights._BEST_BLOCK][0].reverse()
    payload[google_flights._ALL_BLOCK][0].reverse()
    assert google_flights.parse_payload(payload, "USD") == straight


def test_losing_the_all_flights_block_is_drift_even_when_the_best_flights_remain():
    """
    Decision 12.4, applied to the half of the board that carries most of it.

    Returning the five best-departing itineraries would archive a board missing
    the thirty-one behind them and record the collection as healthy, which is
    the silent partial answer the typed error exists to prevent.
    """
    payload = read_payload("google_flights_lim_cuz_payload.json")
    payload[google_flights._ALL_BLOCK] = None
    with pytest.raises(FareError) as caught:
        google_flights.parse_payload(payload, "USD")
    assert caught.value.code == "parse-drift"


def test_a_best_departing_block_google_did_not_send_is_not_drift():
    """The LIM-SCL capture proves this shape is real; refusing it would refuse it."""
    payload = read_payload("google_flights_lim_mad_payload.json")
    payload[google_flights._BEST_BLOCK] = None
    assert len(google_flights.parse_payload(payload, "USD")) == 4


# --- what the flight table's own columns claim ------------------------------
#
# `google_flights_lim_scl_connecting_payload.json` is the board LIM-SCL really
# answered with for 2027-01-21, captured because the archive's worst duration
# was on it and the earlier fixtures were all non-stop or all Madrid. LA 2127
# changes plane at Cusco, which is the case both of these columns got wrong.

CONNECTING = "google_flights_lim_scl_connecting_payload.json"


def every_captured_board():
    """Each captured search board, however it was stored, as `(name, payload)`."""
    page = "google_flights_lim_scl.html"
    yield page, google_flights.extract_payload(read_fixture(page))
    for name in ("google_flights_lim_mad_payload.json", "google_flights_lim_cuz_payload.json"):
        yield name, read_payload(name)
    yield CONNECTING, read_payload(CONNECTING)


def only(offers, airline, number):
    found = [o for o in offers if o.airline == airline and o.flight_number == number]
    assert len(found) == 1, f"{airline} {number}: {len(found)} offers"
    return found[0]


def test_a_connection_is_timed_from_the_gate_it_leaves_to_the_gate_it_arrives_at():
    """
    The defect, on the itinerary the audit found it on.

    LA 2127 leaves Lima at 07:10, sits at Cusco for 175 minutes and reaches
    Santiago at 16:45. Summing the legs made that 280 minutes, "4h 40m", and put
    it above the 205-minute LA 2697 non-stop in a column headed "Duration" — a
    reader sorting on it was handed a flight nearly three hours longer and told
    it was shorter.
    """
    offers = google_flights.parse_payload(read_payload(CONNECTING), "USD")
    connection = only(offers, "LA", "2127")
    assert connection.transfers == 1
    assert connection.duration_minutes == 455
    assert connection.duration_minutes == 280 + 175  # in the air, then on the ground

    non_stop = only(offers, "LA", "2697")
    assert non_stop.duration_minutes == 205
    assert connection.duration_minutes > non_stop.duration_minutes


def test_a_non_stop_reads_the_same_under_either_definition_of_duration():
    """
    The half of the field that was never wrong must not move.

    With no layover to include, the journey and the flying time are the same
    number, and the 103 ARI-SCL rows in the archive are all of this shape.
    """
    scl = google_flights.parse_payload(
        google_flights.extract_payload(read_fixture("google_flights_lim_scl.html")), "USD"
    )
    assert [o.transfers for o in scl] == [0, 0]
    assert [o.duration_minutes for o in scl] == [215, 215]

    for offer in google_flights.parse_payload(read_payload(CONNECTING), "USD"):
        if offer.transfers == 0:
            legs = _legs_of(read_payload(CONNECTING), offer.airline, offer.flight_number)
            assert offer.duration_minutes == legs[0][google_flights._LEG_DURATION]


def _legs_of(payload, airline, number):
    for block in (google_flights._BEST_BLOCK, google_flights._ALL_BLOCK):
        rows = payload[block][0] if isinstance(payload[block], list) else None
        for row in rows or []:
            flight = row[0]
            marker = flight[2][0][google_flights._LEG_FLIGHT]
            if flight[0] == airline and marker[1] == number:
                return flight[2]
    raise AssertionError(f"no {airline} {number} on this board")


def test_the_journey_is_not_the_gap_between_two_local_clocks():
    """
    Why `arrival_at - departure_at` is not the fix it looks like.

    Both stamps are wall clock at their own airport with no offset attached, so
    subtracting them adds however far Santiago's clock is from Lima's. On LA
    2127 that reads 07:10 to 16:45 as 575 minutes, "9h 35m" — the two-hour
    January offset between Peru and Chile, on top of the real 455. Understating
    by 175 and overstating by 120 are the same kind of mistake.

    The layover is the one interval those stamps *can* measure, because a
    connection lands and leaves at one airport and one clock, which is what the
    parser's cross-check is built on.
    """
    connection = only(google_flights.parse_payload(read_payload(CONNECTING), "USD"), "LA", "2127")
    naive = datetime.fromisoformat(connection.arrival_at) - datetime.fromisoformat(
        connection.departure_at
    )
    assert naive == timedelta(minutes=575)
    assert connection.duration_minutes == 455
    assert naive - timedelta(minutes=connection.duration_minutes) == timedelta(hours=2)


def test_every_captured_board_agrees_with_googles_own_journey_figure():
    """
    What identifies position 9 as the duration rather than as some other integer.

    Across every itinerary in every capture, Google's stated total is exactly
    the legs' flying time plus the ground between them. That identity is the
    parser's runtime guard, so it is pinned here on the captures too — if a
    board ever arrives where it does not hold, this fails before production
    starts raising drift at a collection.
    """

    def at(leg, date, time):
        return datetime.fromisoformat(google_flights._stamp(leg[date], leg[time]))

    checked = 0
    for name, payload in every_captured_board():
        for block in (google_flights._BEST_BLOCK, google_flights._ALL_BLOCK):
            rows = payload[block][0] if isinstance(payload[block], list) else None
            for row in rows or []:
                flight = row[0]
                legs = flight[2]
                air = sum(leg[google_flights._LEG_DURATION] for leg in legs)
                ground = sum(
                    int(
                        (
                            at(
                                after,
                                google_flights._LEG_DEPARTURE_DATE,
                                google_flights._LEG_DEPARTURE_TIME,
                            )
                            - at(
                                before,
                                google_flights._LEG_ARRIVAL_DATE,
                                google_flights._LEG_ARRIVAL_TIME,
                            )
                        ).total_seconds()
                        // 60
                    )
                    for before, after in pairwise(legs)
                )
                assert flight[google_flights._ITINERARY_DURATION] == air + ground, name
                checked += 1
    assert checked == 68


def test_a_duration_that_disagrees_with_its_own_legs_is_drift():
    """
    Position 9 renumbering into another plausible integer is the failure this
    parser cannot see any other way — a duration is not absurd on its face.
    """
    payload = read_payload(CONNECTING)
    for block in (google_flights._BEST_BLOCK, google_flights._ALL_BLOCK):
        for row in payload[block][0]:
            row[0][google_flights._ITINERARY_DURATION] = 1

    with pytest.raises(FareError) as caught:
        google_flights.parse_payload(payload, "USD")
    assert caught.value.code == "parse-drift"
    assert "minutes" in caught.value.message


def test_a_board_that_prices_no_journey_at_all_is_drift_rather_than_a_blank_column():
    """
    Decision 12.4 for the case where position 9 stops holding an integer: every
    duration reads `None`, every other field still parses, and the collection
    would be archived as healthy with an empty column.
    """
    payload = read_payload(CONNECTING)
    for block in (google_flights._BEST_BLOCK, google_flights._ALL_BLOCK):
        for row in payload[block][0]:
            row[0][google_flights._ITINERARY_DURATION] = None

    with pytest.raises(FareError) as caught:
        google_flights.parse_payload(payload, "USD")
    assert caught.value.code == "parse-drift"
    assert "duration" in caught.value.message


def test_legs_that_do_not_span_the_itinerary_are_drift_and_never_direct():
    """
    The second defect, measured rather than argued.

    Truncating LA 2127 to its Lima-Cusco leg leaves a payload that parses
    perfectly: one leg, so `transfers` was 0, and an arrival time that looked
    right because it was Cusco's. "Direct" is the strongest claim this table
    makes and it was the parser's default for a leg list it could not check.
    """
    payload = read_payload(CONNECTING)
    for row in payload[google_flights._ALL_BLOCK][0]:
        if row[0][2][0][google_flights._LEG_FLIGHT][1] == "2127":
            row[0][2] = row[0][2][:1]

    with pytest.raises(FareError) as caught:
        google_flights.parse_payload(payload, "USD")
    assert caught.value.code == "parse-drift"
    assert "LIM-SCL" in caught.value.message


def test_a_leg_missing_from_the_middle_of_a_chain_is_drift():
    """
    Spanning the endpoints is not enough on its own: legs that start at Lima and
    finish at Madrid still have to join, or one of them was dropped and the stop
    count is short by however many.
    """
    payload = read_payload("google_flights_lim_mad_payload.json")
    row = next(r for r in payload[google_flights._BEST_BLOCK][0] if len(r[0][2]) == 2)
    row[0][2][0][google_flights._LEG_DESTINATION] = "GRU"

    with pytest.raises(FareError) as caught:
        google_flights.parse_payload(payload, "USD")
    assert caught.value.code == "parse-drift"


def test_an_itinerary_whose_airports_cannot_be_read_is_dropped_not_counted():
    """
    Unreadable and contradictory are different. A row we cannot make sense of is
    one bad row, which the board survives; a row that reads clearly and disagrees
    with itself is the layout having moved, which it does not.
    """
    payload = read_payload(CONNECTING)
    before = len(google_flights.parse_payload(payload, "USD"))
    payload[google_flights._ALL_BLOCK][0][0][0][google_flights._ITINERARY_ORIGIN] = None
    assert len(google_flights.parse_payload(payload, "USD")) == before - 1


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

    It is not in the URL in any readable form — the whole search is a base64
    protobuf in `?tfs=` — so a handler that wants to answer differently per
    route has to decode it, exactly as Google does.
    """
    return base64.b64decode(request.url.params["tfs"]).decode("latin-1")


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
    assert report.results[0].cheapest == 124.64
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


# --------------------------------------------------------- price to the cent --


def test_the_price_is_read_to_the_cent_not_to_the_dollar():
    """
    `itinerary[1][0][1]` is what the page prints, rounded. The token beside it
    carries the same fare as `{units, decimals, currency}`.

    Measured 2026-08-18: two LIM-CUZ offers that both displayed 64 were 63.34
    and 63.36. Rounding merges distinct fares, and the whole job of this
    archive is noticing when a fare moves.
    """
    offers = google_flights.parse_payload(
        google_flights.extract_payload(read_fixture("google_flights_lim_scl.html")), "USD"
    )
    assert offers[0].price == 124.64


def test_an_unreadable_price_token_costs_precision_and_not_the_offer():
    """The rounded integer is always there, so a token we cannot read degrades."""
    assert google_flights._exact_price("not-base64-at-all!!") is None
    assert google_flights._exact_price("") is None
    assert google_flights._exact_price(None) is None


def test_the_free_history_is_read_as_daily_points():
    payload = google_flights.extract_payload(read_fixture("google_flights_lim_scl.html"))
    history = google_flights.parse_history(payload)
    # The fixture was trimmed for the parser tests; whatever it holds, the
    # contract is the shape rather than the count.
    for point in history:
        assert len(point.date) == 10 and point.date[4] == "-"
        assert point.price > 0


def test_a_payload_without_an_insight_block_is_not_an_error():
    """
    Absent is normal. The block thins out past roughly 280 days ahead and is
    gone by 330, and a route we watch a year out must still collect.
    """
    assert google_flights.parse_history([None, None, None, [[]]]) == []
    assert google_flights.parse_insights([None, None, None, [[]]]) is None


# --- the endpoint ------------------------------------------------------------


@pytest.fixture(autouse=True)
def a_runner_with_no_history():
    """
    One pass slot serves the whole process, so it has to be emptied between
    tests — 12.210. Without this a test that asserts on the idle state passes
    or fails depending on which tests ran before it.
    """
    collection_job.RUNNER.forget()
    yield
    collection_job.RUNNER.forget()


def stub_pass(skipped=None, results=None):
    """A collector that reaches nothing and reports what it was handed."""
    seen: dict[str, object] = {}

    async def fake_collect_due(watched, **kwargs):
        seen["watched"] = watched
        seen["budget"] = kwargs.get("budget")
        seen["force"] = kwargs.get("force")
        observer = kwargs.get("observer")
        if observer is not None:
            observer.planned(polling=len(results or []), skipped=list(skipped or []))
            for result in results or []:
                observer.collected(result)
        return CollectionReport(
            started_at="2026-08-19T14:00:00+00:00",
            finished_at="2026-08-19T14:00:06+00:00",
            source="google-flights",
            results=list(results or []),
            skipped=list(skipped or []),
        )

    return seen, fake_collect_due


def wait_for_the_pass(client, timeout=5.0):
    """
    Poll `GET /collect` until the pass stops running, and return it.

    A press is answered before the work is done — 12.210 — so a test that
    asserted on the POST's body alone would be asserting about a pass that had
    not started yet. This is the same thing the browser does, and testing it
    the way the client uses it is the point.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        answer = client.get("/api/fares/collect")
        assert answer.status_code == 200
        body = answer.json()
        if body["state"] != "running":
            return body
        time.sleep(0.01)
    raise AssertionError("the collection pass never finished")


def test_nothing_has_been_collected_yet_is_an_answer_rather_than_a_404():
    """
    A fresh install has never run a pass, and that is an ordinary state rather
    than an error — 12.210. Answering 404 would make every client special-case
    a failure to describe a machine that is simply idle.
    """
    with TestClient(app) as client:
        body = client.get("/api/fares/collect").json()
    assert body["state"] == "idle"
    assert body["startedAt"] is None
    assert body["polling"] is None
    assert body["results"] == [] and body["skipped"] == []


def test_a_press_is_answered_before_the_pass_it_started_has_finished(monkeypatch):
    """
    12.210. The press returns 202 and a document, not a completed report.

    This is the whole of what the change buys: the browser's five-minute
    deadline used to be what decided how many departures a press could cover,
    and a press that is answered immediately has no deadline to fit inside. The
    ceiling that deadline implied — forty requests — is gone with it, so the
    pass is handed no budget at all and falls back to the request budget.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        assert answer.status_code == 202
        assert answer.json()["watching"] == ["LIM-SCL 2027-03"]
        finished = wait_for_the_pass(client)

    assert finished["state"] == "finished"
    assert finished["finishedAt"] is not None
    # No per-call ceiling any more. `collect_due` falls back to the request
    # budget, which is what the bound should always have been.
    assert seen["budget"] is None


def test_a_running_pass_says_how_far_through_it_is(monkeypatch):
    """
    A four-minute pass that could only be described once it ended would leave
    the reader watching a spinner and a promise — 12.210. `polling` lands
    before the first request so the figure has a denominator from the start.
    """
    result = RouteResult(
        origin="LIM",
        destination="SCL",
        flight_date="2027-03-01",
        return_date=None,
        ok=True,
        changed=True,
        offers=3,
    )
    _, fake = stub_pass(skipped=[("LIM-SCL 2027-03-02", "not-due")], results=[result])
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        finished = wait_for_the_pass(client)

    assert finished["polling"] == 1
    assert finished["completed"] == 1
    assert finished["collected"] == 1 and finished["changed"] == 1
    assert finished["results"][0]["flightDate"] == "2027-03-01"


def test_a_second_press_joins_the_running_pass_rather_than_starting_another(monkeypatch):
    """
    The gap in `fare_collector` paces one loop, so two loops would halve it
    with nobody having decided to — 12.210. The second press is answered with
    the pass that is already going, and `watching` is what says so: a caller
    whose own route is missing from it knows it was answered rather than served.
    """
    started = asyncio.Event()
    release = asyncio.Event()
    calls: list[list] = []

    async def slow_collect_due(watched, **kwargs):
        calls.append(watched)
        observer = kwargs.get("observer")
        if observer is not None:
            observer.planned(polling=1, skipped=[])
        started.set()
        await release.wait()
        return CollectionReport(
            started_at="2026-08-19T14:00:00+00:00",
            finished_at="2026-08-19T14:00:06+00:00",
            source="google-flights",
            results=[],
            skipped=[],
        )

    monkeypatch.setattr(collection_job, "collect_due", slow_collect_due)

    with TestClient(app) as client:
        first = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        assert first.status_code == 202
        # Give the task a turn on the loop, so the second press meets a pass
        # that has genuinely begun rather than one still queued.
        deadline = time.monotonic() + 5.0
        while not started.is_set() and time.monotonic() < deadline:
            client.get("/api/fares/collect")
            time.sleep(0.01)
        assert started.is_set()

        second = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "ARI", "destination": "SCL", "month": "2027-03"}]},
        )
        assert second.status_code == 202
        # Somebody else's pass, and the document says whose.
        assert second.json()["state"] == "running"
        assert second.json()["watching"] == ["LIM-SCL 2027-03"]

        release.set()
        wait_for_the_pass(client)

    assert len(calls) == 1


def test_a_pass_that_falls_over_says_so_rather_than_running_forever(monkeypatch):
    """
    8.8 again, in the one place it had nowhere to be reported: a background
    task that raises hands its exception to the event loop, where a browser
    polling for progress would see a pass that is running and always will be.
    """

    async def broken_collect_due(watched, **kwargs):
        raise RuntimeError("the archive volume went away")

    monkeypatch.setattr(collection_job, "collect_due", broken_collect_due)

    with TestClient(app) as client:
        client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        finished = wait_for_the_pass(client)

    assert finished["state"] == "failed"
    assert "the archive volume went away" in finished["error"]
    assert finished["finishedAt"] is not None


def test_the_collect_endpoint_takes_a_month_and_refuses_anything_else(monkeypatch):
    """
    The client sends what the reader watches — a city pair and a month, 12.110.

    It no longer knows which departures exist inside one, and it should not:
    expanding a month is the collector's job because only the collector can
    also report the days it decided to leave alone, and why.

    A typo is a 422 the client can show rather than a month that silently
    expands to nothing.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        ok = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "lim", "destination": "scl", "month": "2027-03"}]},
        )
        assert ok.status_code == 202
        wait_for_the_pass(client)
        assert seen["watched"] == [FareWatch(origin="LIM", destination="SCL", month="2027-03")]

        for bad in ("2027-3", "2027-13", "2027-03-09", "soon"):
            refused = client.post(
                "/api/fares/collect",
                json={"routes": [{"origin": "LIM", "destination": "SCL", "month": bad}]},
            )
            assert refused.status_code == 422, bad


def test_the_collect_body_carries_a_city_pair_and_a_month_and_nothing_else(monkeypatch):
    """
    12.266. The body used to carry `focusDate` beside the month.

    That was the one reading preference this API ever accepted, and the only
    thing it did was decide which departure survived a truncated pass (12.134).
    A watch names no departure now, so the field is gone from the model — and a
    stale client still sending it is ignored rather than refused, which is
    Pydantic's default and the right answer: the value would only have changed
    the order of a pass, and the pass now orders by distance.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "lim", "destination": "scl", "month": "2027-03"}]},
        )
        assert answer.status_code == 202
        wait_for_the_pass(client)
        assert seen["watched"] == [FareWatch(origin="LIM", destination="SCL", month="2027-03")]

        stale = client.post(
            "/api/fares/collect",
            json={
                "routes": [
                    {
                        "origin": "LIM",
                        "destination": "SCL",
                        "month": "2027-03",
                        "focusDate": "2027-03-09",
                    }
                ]
            },
        )
        assert stale.status_code == 202
        wait_for_the_pass(client)
        assert seen["watched"] == [FareWatch(origin="LIM", destination="SCL", month="2027-03")]
        assert not hasattr(seen["watched"][0], "focus")


def test_the_collect_endpoint_runs_the_schedule_unless_it_is_told_not_to(monkeypatch):
    """
    12.111 is still the default here — `a-press-collects-the-month-it-is-on`
    only adds a way to say otherwise, and a body that says nothing gets exactly
    what it got before.

    A call with no `force` runs the cadence and reports what it declined, which
    is what stops a press that collected nothing from looking like a broken
    button. This is the scheduled and command-line shape of the endpoint, and it
    is asserted rather than assumed because the whole safety of the change rests
    on the default not having moved.
    """
    seen, fake = stub_pass(skipped=[("LIM-SCL 2027-03-01", "not-due")])
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
        )
        assert answer.status_code == 202
        finished = wait_for_the_pass(client)

    assert seen["force"] is False
    assert finished["skipped"] == [{"what": "LIM-SCL 2027-03-01", "reason": "not-due"}]


def test_a_forced_press_reaches_the_collector_as_every_month_of_one_route(monkeypatch):
    """
    `a-press-collects-the-month-it-is-on`, widened by
    `a-watch-is-a-pair-and-its-months`.

    The reader pressed a control on one row, and a row is a city pair and every
    month of it — so what arrives at the collector is one watch per month, with
    the flag set. The endpoint is what carries it, so this is where the wire
    word and the collector's parameter are pinned to each other.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={
                "routes": [
                    {"origin": "lim", "destination": "scl", "month": "2027-03"},
                    {"origin": "lim", "destination": "scl", "month": "2027-04"},
                ],
                "force": True,
            },
        )
        assert answer.status_code == 202
        wait_for_the_pass(client)

    assert seen["force"] is True
    assert seen["watched"] == [
        FareWatch(origin="LIM", destination="SCL", month="2027-03"),
        FareWatch(origin="LIM", destination="SCL", month="2027-04"),
    ]


def test_a_forced_press_covers_one_city_pair_and_is_refused_anything_wider(monkeypatch):
    """
    The narrowing 12.212's cost argument turns on, restated for a wider watch.

    This asserted "exactly one route entry" and meant "one city pair" — the two
    were the same thing only while a watch was one month, and they stopped being
    the same when a press started sending every month of a row. The line moves
    to where `collect_calendars` has always drawn it (`if force and len(pairs) >
    1`), so both layers now say *pair* rather than disagreeing about it.

    What retires with the old wording is the price. 12.212 costed a press at
    thirty-one board requests at the very most; twelve months of one pair is
    ~372, which is more than the busiest day this address has ever sent. That
    bound is not this endpoint's any more — what holds it is the pace and the
    pass lock, plus the horizon, which is why the months-per-pair ceiling below
    is derived from the horizon rather than chosen.

    The same bodies without the flag are still accepted: what is bounded is the
    *forced* press.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)
    two_pairs = [
        {"origin": "LIM", "destination": "SCL", "month": "2027-03"},
        {"origin": "LIM", "destination": "CUZ", "month": "2027-04"},
    ]
    two_months = [
        {"origin": "LIM", "destination": "SCL", "month": "2027-03"},
        {"origin": "LIM", "destination": "SCL", "month": "2027-04"},
    ]

    with TestClient(app) as client:
        refused = client.post("/api/fares/collect", json={"routes": two_pairs, "force": True})
        assert refused.status_code == 400
        assert "one city pair" in refused.json()["detail"]

        # Two months of one pair is the case that used to be refused and is now
        # the whole point of the change.
        allowed = client.post("/api/fares/collect", json={"routes": two_months, "force": True})
        assert allowed.status_code == 202
        wait_for_the_pass(client)
        assert seen["force"] is True
        assert len(seen["watched"]) == 2

        unforced = client.post("/api/fares/collect", json={"routes": two_pairs})
        assert unforced.status_code == 202
        wait_for_the_pass(client)
        assert seen["force"] is False
        assert len(seen["watched"]) == 2


def test_more_months_than_the_horizon_reaches_is_refused(monkeypatch):
    """
    The ceiling that replaced the flat cap on entries, and why it is twelve.

    A departure past `MAX_DEPARTURE_HORIZON_DAYS` cannot be collected at all,
    and 330 days touches at most twelve calendar months — so a thirteenth month
    on one pair is not an expensive request, it is a request for departures the
    provider does not have. The refusal names the pair and the reason, because a
    client that cannot say which row was too wide cannot show the reader.
    """
    _, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    def months(count: int) -> list[dict[str, str]]:
        # Rolled into the next year rather than counted past twelve: `2027-13`
        # is refused by `RouteBody`'s own pattern as a 422, which would test the
        # model rather than the ceiling this test is about.
        return [
            {
                "origin": "LIM",
                "destination": "SCL",
                "month": f"{2027 + index // 12}-{index % 12 + 1:02d}",
            }
            for index in range(count)
        ]

    with TestClient(app) as client:
        refused = client.post("/api/fares/collect", json={"routes": months(13)})
        assert refused.status_code == 400
        detail = refused.json()["detail"]
        assert "LIM-SCL" in detail and "13 months" in detail

        allowed = client.post("/api/fares/collect", json={"routes": months(12)})
        assert allowed.status_code == 202
        wait_for_the_pass(client)


def test_an_unforced_body_may_carry_more_entries_than_months_in_a_year(monkeypatch):
    """
    The flat cap on entries is gone, and its absence is pinned.

    `MAX_COLLECT_MONTHS` counted routes while being named for months, and once
    one entry stopped meaning one month it bounded neither. It also refused over
    HTTP what `scripts/fares-collect.py` hands the collector by hand every
    fifteen minutes — the whole watchlist at once — which is a bound on the wire
    rather than on the work.
    """
    seen, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)
    wide = [
        {"origin": origin, "destination": "SCL", "month": f"2027-{index:02d}"}
        for origin in ("LIM", "CUZ", "AQP")
        for index in range(1, 6)
    ]

    with TestClient(app) as client:
        answer = client.post("/api/fares/collect", json={"routes": wide})
        assert answer.status_code == 202
        wait_for_the_pass(client)

    assert len(seen["watched"]) == 15


def test_a_pass_names_every_month_it_covers_and_names_each_one_once(monkeypatch):
    """
    What the client matches on, and the one way it can be lied to.

    `watching` is how a row decides whether the pass in hand is its own, so a
    body that repeats a month must not have the pass name it twice: `expand`
    collapses the repeat into one set of departures, and a document naming it
    twice would promise work no result will ever arrive for. Order is the order
    sent, because that is the order the day is spent down in.
    """
    _, fake = stub_pass()
    monkeypatch.setattr(collection_job, "collect_due", fake)

    with TestClient(app) as client:
        answer = client.post(
            "/api/fares/collect",
            json={
                "routes": [
                    {"origin": "AEP", "destination": "SCL", "month": "2027-03"},
                    {"origin": "AEP", "destination": "SCL", "month": "2027-04"},
                    {"origin": "AEP", "destination": "SCL", "month": "2027-03"},
                ],
                "force": True,
            },
        )
        assert answer.status_code == 202
        finished = wait_for_the_pass(client)

    assert finished["watching"] == ["AEP-SCL 2027-03", "AEP-SCL 2027-04"]


def test_five_impatient_presses_start_one_pass(monkeypatch):
    """
    The hazard 12.212 named, measured rather than reasoned about.

    A forced press is ninety-odd seconds of paced requests behind a control that
    answers instantly, so the reader who clicks five times waiting for something
    to happen is the ordinary case rather than the perverse one. Five presses
    here, all forced, all inside one running pass: `collect_due` is entered
    once, so the day is charged for one month and not five.

    Pressed straight at the endpoint, past the browser. The row's own guards —
    a synchronous in-flight ref and a disabled button — are real and are tested
    on the web side, and they are not what makes this safe: a second tab defeats
    both. `CollectionRunner`'s single slot is what cannot be defeated, and this
    is the test of that slot rather than of the button.
    """
    entered: list[bool] = []
    release = asyncio.Event()

    async def slow_collect_due(watched, **kwargs):
        entered.append(bool(kwargs.get("force")))
        observer = kwargs.get("observer")
        if observer is not None:
            observer.planned(polling=31, skipped=[])
        await release.wait()
        return CollectionReport(
            started_at="2026-08-19T14:00:00+00:00",
            finished_at="2026-08-19T14:01:33+00:00",
            source="google-flights",
            results=[],
            skipped=[],
        )

    monkeypatch.setattr(collection_job, "collect_due", slow_collect_due)
    body = {
        "routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}],
        "force": True,
    }

    with TestClient(app) as client:
        answers = [client.post("/api/fares/collect", json=body) for _ in range(5)]
        assert [answer.status_code for answer in answers] == [202] * 5
        # Every one of them is answered with a document, and it is the *same*
        # pass: a caller cannot tell it was refused except by the fact that the
        # pass it was handed started before it pressed.
        started = {answer.json()["startedAt"] for answer in answers}
        assert len(started) == 1
        assert all(answer.json()["state"] == "running" for answer in answers)

        release.set()
        wait_for_the_pass(client)

    assert entered == [True]


def test_the_history_endpoint_narrows_a_month_or_a_single_day(monkeypatch, tmp_path):
    """
    `departure` is a prefix — 12.112. `2027-03` selects the month a route is
    now watched by and `2027-03-09` still selects one departure, because these
    keys are `YYYY-MM-DD` and truncate the way the calendar does.
    """
    from app.adapters.fares.models import PricePoint

    history = FareHistory(tmp_path)
    for departure, price in (("2027-03-09", 210.0), ("2027-03-10", 240.0), ("2027-04-02", 900.0)):
        history.merge_baseline(
            "LIM", "SCL", departure, [PricePoint("2026-08-18", price)], source="s", currency="USD"
        )
    monkeypatch.setattr(fares_router, "HISTORY", history)
    client = TestClient(app)

    march = client.get("/api/fares/history?origin=LIM&destination=SCL&departure=2027-03")
    assert [point["price"] for point in march.json()["baseline"]] == [210.0, 240.0]

    ninth = client.get("/api/fares/history?origin=LIM&destination=SCL&departure=2027-03-09")
    assert [point["price"] for point in ninth.json()["baseline"]] == [210.0]


def test_a_baseline_figure_says_which_departure_it_priced(monkeypatch, tmp_path):
    """
    12.171. A watched month brings back one of these series per departure, so
    the same observation date arrives thirty-one times with thirty-one prices.
    Without the departure beside it the client cannot tell those rows apart —
    and cannot work out how far ahead of the flight any of them was quoted,
    which is the whole of what a lead-time axis is drawn on.
    """
    from app.adapters.fares.models import PricePoint

    history = FareHistory(tmp_path)
    for departure, price in (("2027-03-09", 210.0), ("2027-03-10", 240.0)):
        history.merge_baseline(
            "LIM", "SCL", departure, [PricePoint("2026-08-18", price)], source="s", currency="USD"
        )
    monkeypatch.setattr(fares_router, "HISTORY", history)

    baseline = (
        TestClient(app)
        .get("/api/fares/history?origin=LIM&destination=SCL&departure=2027-03")
        .json()["baseline"]
    )
    assert [(point["flightDate"], point["date"]) for point in baseline] == [
        ("2027-03-09", "2026-08-18"),
        ("2027-03-10", "2026-08-18"),
    ]
