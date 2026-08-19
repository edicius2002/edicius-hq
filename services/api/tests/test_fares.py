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
from fastapi.testclient import TestClient

from app.adapters import wire
from app.adapters.fares import google_flights
from app.adapters.fares.models import FareError, FareOffer, FareQuery, FareSnapshot
from app.main import app
from app.routers import fares as fares_router
from app.services.fare_collector import CollectionReport, FareWatch, collect
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


def stub_pass(skipped=None):
    """A collector that reaches nothing and reports what it was handed."""
    seen: dict[str, object] = {}

    async def fake_collect_due(watched, **kwargs):
        seen["watched"] = watched
        seen["budget"] = kwargs.get("budget")
        return CollectionReport(
            started_at="2026-08-19T14:00:00+00:00",
            finished_at="2026-08-19T14:00:06+00:00",
            source="google-flights",
            results=[],
            skipped=list(skipped or []),
        )

    return seen, fake_collect_due


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
    monkeypatch.setattr(fares_router, "collect_due", fake)
    client = TestClient(app)

    ok = client.post(
        "/api/fares/collect",
        json={"routes": [{"origin": "lim", "destination": "scl", "month": "2027-03"}]},
    )
    assert ok.status_code == 200
    assert seen["watched"] == [FareWatch(origin="LIM", destination="SCL", month="2027-03")]
    # Capped per call, not per day: forty paced requests is four minutes, which
    # is what fits inside the client's own deadline.
    assert seen["budget"] == fares_router.MAX_COLLECT_REQUESTS

    for bad in ("2027-3", "2027-13", "2027-03-09", "soon"):
        refused = client.post(
            "/api/fares/collect",
            json={"routes": [{"origin": "LIM", "destination": "SCL", "month": bad}]},
        )
        assert refused.status_code == 422, bad


def test_the_collect_endpoint_runs_the_schedule_rather_than_bypassing_it(monkeypatch):
    """
    12.111, superseding the second half of 12.90.

    A press used to buy one request, and someone who has decided where to spend
    one should not be argued with by a cadence table. Under 12.110 the same
    press buys up to thirty-one — a tenth of the day's budget per click — so it
    runs the schedule and reports what it declined, which is what stops a press
    that collected nothing from looking like a broken button.
    """
    _, fake = stub_pass(skipped=[("LIM-SCL 2027-03-01", "not-due")])
    monkeypatch.setattr(fares_router, "collect_due", fake)
    client = TestClient(app)

    answer = client.post(
        "/api/fares/collect",
        json={"routes": [{"origin": "LIM", "destination": "SCL", "month": "2027-03"}]},
    )
    assert answer.status_code == 200
    assert answer.json()["skipped"] == [{"what": "LIM-SCL 2027-03-01", "reason": "not-due"}]


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
