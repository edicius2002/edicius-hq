"""
The Google Flights adapter's parsing, pinned against captured fixtures.

The adapter is a scraper of an untagged array, so every index it depends on is
a position that a Google refactor renumbers silently. These tests are the alarm
for that: the payload, both departing blocks, the columns the flight table's
own header claims, and the price read to the cent rather than to the dollar.

Out of `test_fares.py`.
"""

from datetime import datetime, timedelta
from itertools import pairwise

import pytest
from conftest import read_fixture, read_payload

from app.adapters.fares import google_flights
from app.adapters.fares.models import FareError, FareSnapshot
from app.services.fare_history import FareHistory

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
    no price at all; they remain observations, with `price=None`, rather than
    silently disappearing from the board.
    """
    payload = read_payload("google_flights_lim_cuz_payload.json")
    assert len(payload[google_flights._BEST_BLOCK][0]) == 6
    assert len(payload[google_flights._ALL_BLOCK][0]) == 37

    offers = google_flights.parse_payload(payload, "USD")
    assert len(offers) == 43
    assert sum(offer.price is None for offer in offers) == 7
    assert len({(o.airline, o.flight_number, o.departure_at, o.arrival_at) for o in offers}) == 43


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
    assert connection.via_points == ("CUZ",)
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
    assert "none could be read" in caught.value.message


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


def test_legs_that_do_not_span_the_itinerary_are_dropped_and_never_direct():
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

    offers = google_flights.parse_payload(payload, "USD")
    assert all(offer.flight_number != "2127" for offer in offers)


def test_a_leg_missing_from_the_middle_of_a_chain_is_drift():
    """
    Spanning the endpoints is not enough on its own: legs that start at Lima and
    finish at Madrid still have to join, or one of them was dropped and the stop
    count is short by however many.
    """
    payload = read_payload("google_flights_lim_mad_payload.json")
    row = next(r for r in payload[google_flights._BEST_BLOCK][0] if len(r[0][2]) == 2)
    row[0][2][0][google_flights._LEG_DESTINATION] = "GRU"
    payload[google_flights._BEST_BLOCK] = None
    payload[google_flights._ALL_BLOCK] = [[row]]

    with pytest.raises(FareError) as caught:
        google_flights.parse_payload(payload, "USD")
    assert caught.value.code == "parse-drift"


def test_an_airport_transfer_in_the_same_metropolitan_area_is_a_valid_connection():
    """AEP to EZE is a ground transfer in Buenos Aires, not a missing leg."""
    offers = google_flights.parse_payload(
        read_payload("google_flights_airport_transfer_payload.json"), "USD"
    )

    assert [
        (offer.airline, offer.flight_number, offer.transfers, offer.price, offer.via_points)
        for offer in offers
    ] == [("AR", "1365", 1, 824.0, ("AEP",))]


def test_a_bad_itinerary_does_not_refuse_the_other_readable_rows():
    """A contradictory row is drift, but it is not proof that its neighbours are."""
    payload = read_payload("google_flights_lim_mad_payload.json")
    before = len(google_flights.parse_payload(payload, "USD"))
    row = next(r for r in payload[google_flights._BEST_BLOCK][0] if len(r[0][2]) == 2)
    row[0][2][0][google_flights._LEG_DESTINATION] = "GRU"

    assert len(google_flights.parse_payload(payload, "USD")) == before - 1


def test_an_all_block_of_unpriced_itineraries_is_archived_with_no_invented_fare(tmp_path):
    """Google's explicit no-price rows are flights, not unreadable payload drift."""
    offers = google_flights.parse_payload(
        read_payload("google_flights_all_unpriced_payload.json"), "USD"
    )

    assert [
        (offer.airline, offer.flight_number, offer.price, offer.via_points) for offer in offers
    ] == [("H2", "1313", None, ())]
    history = FareHistory(tmp_path)
    history.append(
        FareSnapshot(
            captured_at="2026-09-04T12:00:00+00:00",
            source="google-flights",
            origin="ARI",
            destination="SCL",
            flight_date="2026-09-04",
            return_date=None,
            currency="USD",
            offers=offers,
        )
    )
    saved = history.read("ARI", "SCL")[0]
    assert saved.offers[0].price is None
    assert saved.offers[0].via_points == ()
    assert saved.cheapest is None


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
