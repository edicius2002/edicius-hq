"""
The second fare provider, and the rule for when it is allowed to speak.

Two things are being defended here. One is the mapping: Travelpayouts reports a
departure time *with* the origin's UTC offset, and `google_flights` reports the
same moment as bare wall clock. If the adapter let the offset through, two rows
in one archive would mean different things while looking identical.

The other is the fallback rule. Reaching for a second provider is right when
the first could not answer and wrong when it did — a route with genuinely no
service that day would otherwise be filled in with a cached price every day
forever, and the series would show a flight that does not exist.

Payload shapes below are trimmed from a real response captured on 2026-08-18.
"""

import asyncio
import base64
from pathlib import Path

import httpx
import pytest

from app.adapters.fares import travelpayouts
from app.adapters.fares.models import FareError, FareQuery
from app.adapters.fares.registry import fetch_with_fallback
from app.services.fare_collector import collect
from app.services.fare_history import FareHistory

QUERY = FareQuery("LIM", "CUZ", "2026-10-17")


def row(**overrides):
    """One offer as the API really spells it."""
    base = {
        "flight_number": "7029",
        "origin_airport": "LIM",
        "destination_airport": "CUZ",
        "departure_at": "2026-10-17T19:55:00-05:00",
        "airline": "JA",
        "destination": "CUZ",
        "origin": "LIM",
        "price": 42,
        "gate": "Clickavia",
        "return_transfers": 0,
        "duration": 80,
        "duration_to": 80,
        "duration_back": 0,
        "transfers": 0,
    }
    base.update(overrides)
    return base


def body(*rows, success=True):
    return {"success": success, "data": list(rows), "currency": "usd"}


def transport(handler):
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


def with_token(monkeypatch, token="test-token", marker=None):
    monkeypatch.setenv("TRAVELPAYOUTS_TOKEN", token)
    if marker:
        monkeypatch.setenv("TRAVELPAYOUTS_MARKER", marker)


# --------------------------------------------------------------- time zones --


@pytest.mark.parametrize(
    ("reported", "expected"),
    [
        ("2026-10-17T19:55:00-05:00", "2026-10-17T19:55"),
        ("2026-10-17T00:15:00-05:00", "2026-10-17T00:15"),
        ("2026-10-17T19:55:00+02:00", "2026-10-17T19:55"),
        ("2026-10-17T19:55:30-05:00", "2026-10-17T19:55:30"),
        ("2026-10-17T19:55:00Z", "2026-10-17T19:55"),
        ("2026-10-17T19:55", "2026-10-17T19:55"),
    ],
)
def test_the_offset_is_dropped_and_the_wall_clock_kept(reported, expected):
    assert travelpayouts._wall_clock(reported) == expected


def test_a_midnight_departure_keeps_its_date():
    """
    The failure this guards is specific: converting `00:15-05:00` to UTC moves
    it to 05:15 the *next* day, and the archive keys observations by departure
    date. The flight would silently move to a date it does not depart on.
    """
    offers = travelpayouts.parse_payload(body(row(departure_at="2026-10-17T00:15:00-05:00")), "USD")
    assert offers[0].departure_at == "2026-10-17T00:15"


@pytest.mark.parametrize("junk", [None, 42, "", "not-a-stamp", "2026-10-17", "20261017T1955"])
def test_an_unreadable_stamp_is_none_rather_than_a_guess(junk):
    assert travelpayouts._wall_clock(junk) is None


# ------------------------------------------------------------------ parsing --


def test_a_real_row_maps_onto_the_shared_offer_shape():
    (offer,) = travelpayouts.parse_payload(body(row()), "USD")
    assert offer.airline == "JA"
    assert offer.flight_number == "7029"
    assert offer.departure_at == "2026-10-17T19:55"
    assert offer.transfers == 0
    assert offer.duration_minutes == 80
    assert offer.price == 42.0
    assert offer.currency == "USD"
    # The API sends no carrier name. Filling it with the code would render "JA"
    # in a column headed by a human-readable name.
    assert offer.airline_name is None
    # And no arrival. Deriving one from `duration_to` across two time zones
    # would produce a plausible wrong time instead of an honest gap.
    assert offer.arrival_at is None


def test_offers_come_back_cheapest_first():
    offers = travelpayouts.parse_payload(body(row(price=120), row(price=42), row(price=80)), "USD")
    assert [offer.price for offer in offers] == [42.0, 80.0, 120.0]


def test_one_unreadable_row_does_not_cost_the_readable_ones():
    offers = travelpayouts.parse_payload(body(row(), row(airline=None), "nonsense"), "USD")
    assert len(offers) == 1


@pytest.mark.parametrize("broken", [{"price": 0}, {"price": -5}, {"price": None}, {"airline": ""}])
def test_a_row_without_a_usable_price_or_carrier_is_dropped(broken):
    with pytest.raises(FareError) as caught:
        travelpayouts.parse_payload(body(row(**broken)), "USD")
    assert caught.value.code == "parse-drift"


def test_an_empty_list_is_no_offers_not_drift():
    """
    "The cache has nothing for this date" and "the shape changed" must not be
    the same code: the first is normal on a thin route, the second is an alarm.
    """
    with pytest.raises(FareError) as caught:
        travelpayouts.parse_payload(body(), "USD")
    assert caught.value.code == "no-offers"


def test_rows_that_arrive_and_cannot_be_read_are_drift():
    with pytest.raises(FareError) as caught:
        travelpayouts.parse_payload(body({"nope": 1}, {"nope": 2}), "USD")
    assert caught.value.code == "parse-drift"
    assert "2 row(s)" in caught.value.message


def test_the_api_saying_no_is_an_upstream_error():
    with pytest.raises(FareError) as caught:
        travelpayouts.parse_payload({"success": False, "error": "Invalid token"}, "USD")
    assert caught.value.code == "upstream-error"
    assert "Invalid token" in caught.value.message


# ----------------------------------------------------------------- requests --


def test_a_one_way_query_asks_for_a_one_way_price(monkeypatch):
    """
    The v1 endpoints answer with round-trip prices even when no return date was
    asked for. A return fare in a one-way series reads as a price jump that
    never happened, so `one_way` is not optional for us.
    """
    with_token(monkeypatch)
    seen = {}

    def handler(request):
        seen.update(request.url.params)
        return httpx.Response(200, json=body(row()))

    async def run():
        async with transport(handler) as client:
            return await travelpayouts.fetch_offers(client, QUERY)

    asyncio.run(run())
    assert seen["one_way"] == "true"
    assert "return_at" not in seen
    assert seen["departure_at"] == "2026-10-17"
    assert seen["currency"] == "usd"


def test_a_return_date_replaces_the_one_way_flag(monkeypatch):
    with_token(monkeypatch)
    seen = {}

    def handler(request):
        seen.update(request.url.params)
        return httpx.Response(200, json=body(row()))

    async def run():
        async with transport(handler) as client:
            return await travelpayouts.fetch_offers(
                client, FareQuery("LIM", "CUZ", "2026-10-17", return_date="2026-10-24")
            )

    asyncio.run(run())
    assert seen["return_at"] == "2026-10-24"
    assert "one_way" not in seen


def test_the_marker_narrows_the_cache_to_our_own_searches(monkeypatch):
    with_token(monkeypatch, marker="123456")
    seen = {}

    def handler(request):
        seen.update(request.url.params)
        return httpx.Response(200, json=body(row()))

    async def run():
        async with transport(handler) as client:
            return await travelpayouts.fetch_offers(client, QUERY)

    asyncio.run(run())
    assert seen["marker"] == "123456"
    assert seen["show_to_affiliates"] == "true"


def test_no_token_is_a_configuration_state_not_a_crash():
    """
    The registry keeps a provider that needs no token, so a missing one has to
    mean "this provider is unavailable" and say which knob to turn.
    """

    async def run():
        async with transport(lambda request: httpx.Response(200, json=body(row()))) as client:
            return await travelpayouts.fetch_offers(client, QUERY)

    with pytest.raises(FareError) as caught:
        asyncio.run(run())
    assert caught.value.code == "no-credential"
    assert ".env.example" in caught.value.message


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (401, "no-credential"),
        (403, "no-credential"),
        (429, "rate-limited"),
        (500, "upstream-error"),
    ],
)
def test_http_failures_keep_their_own_names(monkeypatch, status_code, expected):
    with_token(monkeypatch)

    async def run():
        async with transport(lambda request: httpx.Response(status_code, text="no")) as client:
            return await travelpayouts.fetch_offers(client, QUERY)

    with pytest.raises(FareError) as caught:
        asyncio.run(run())
    assert caught.value.code == expected


# ----------------------------------------------------------------- fallback --


def test_the_fallback_answers_when_the_scraper_cannot(monkeypatch):
    with_token(monkeypatch)

    def handler(request):
        if "google.com" in str(request.url):
            return httpx.Response(429, text="slow down")
        return httpx.Response(200, json=body(row()))

    async def run():
        async with transport(handler) as client:
            return await fetch_with_fallback(client, QUERY)

    source, offers = asyncio.run(run())
    assert source == "travelpayouts"
    assert offers[0].price == 42.0


def test_no_offers_is_an_answer_and_does_not_reach_for_the_fallback(monkeypatch):
    """
    The rule that keeps a phantom flight out of the archive. If "Google says
    there are no flights that day" fell through to a cached price, a route with
    no service would grow a price every single day.
    """
    with_token(monkeypatch)
    asked = []

    def handler(request):
        asked.append(str(request.url))
        if "google.com" in str(request.url):
            empty = "[null,null,null,[null],null,null,null,null]"
            return httpx.Response(
                200,
                text=f'<script class="ds:1">AF_initDataCallback({{data:{empty}, sideChannel: {{}}}});</script>',
            )
        return httpx.Response(200, json=body(row()))

    async def run():
        async with transport(handler) as client:
            return await fetch_with_fallback(client, QUERY)

    with pytest.raises(FareError) as caught:
        asyncio.run(run())
    assert caught.value.code == "no-offers"
    assert not any("travelpayouts" in url for url in asked)


def test_when_both_refuse_the_primary_error_is_the_one_reported(monkeypatch):
    """
    "TRAVELPAYOUTS_TOKEN is not set" would be a true statement about the wrong
    problem when the real news is that Google is blocking the address.
    """

    async def run():
        async with transport(lambda request: httpx.Response(429, text="no")) as client:
            return await fetch_with_fallback(client, QUERY)

    with pytest.raises(FareError) as caught:
        asyncio.run(run())
    assert caught.value.code == "rate-limited"


def test_a_collected_snapshot_records_who_actually_answered(monkeypatch, tmp_path):
    """
    The archive holds two kinds of observation now — a live itinerary list and
    a cached cheapest-of-the-day — and a reader has to be able to tell which
    one a point came from.
    """
    with_token(monkeypatch)
    history = FareHistory(tmp_path)

    def handler(request):
        if "google.com" in str(request.url):
            return httpx.Response(503, text="down")
        return httpx.Response(200, json=body(row()))

    async def run():
        async with transport(handler) as client:
            return await collect([QUERY], history=history, client=client, gap_seconds=0)

    report = asyncio.run(run())
    assert report.collected == 1
    assert report.sources == ["travelpayouts"]
    assert report.results[0].source == "travelpayouts"

    (stored,) = history.read("LIM", "CUZ")
    assert stored.source == "travelpayouts"
    assert stored.offers[0].departure_at == "2026-10-17T19:55"


def test_a_pass_served_by_both_providers_names_both(monkeypatch, tmp_path):
    """One pass, two kinds of answer, and a report that does not round to one."""
    with_token(monkeypatch)
    history = FareHistory(tmp_path)
    html = (Path(__file__).parent / "fixtures" / "google_flights_lim_scl.html").read_text(
        encoding="utf-8"
    )

    def handler(request):
        url = str(request.url)
        if "google.com" not in url:
            return httpx.Response(200, json=body(row()))
        # The destination is inside the base64 protobuf, not the URL.
        searched = base64.b64decode(request.url.params["tfs"]).decode("latin-1")
        if "CUZ" in searched:
            return httpx.Response(503, text="down")
        return httpx.Response(200, text=html)

    async def run():
        async with transport(handler) as client:
            return await collect(
                [FareQuery("LIM", "SCL", "2026-10-16"), QUERY],
                history=history,
                client=client,
                gap_seconds=0,
            )

    report = asyncio.run(run())
    assert report.collected == 2
    assert report.sources == ["google-flights", "travelpayouts"]
    assert [result.source for result in report.results] == ["google-flights", "travelpayouts"]


def test_a_silent_transport_error_still_says_something(monkeypatch):
    """
    Measured live: a read timeout stringifies to nothing, so the report read
    "could not be reached: " and stopped. A line that costs space and carries
    no reason is worse than no line.
    """
    with_token(monkeypatch)

    def handler(request):
        raise httpx.ReadTimeout("")

    async def run():
        async with transport(handler) as client:
            return await travelpayouts.fetch_offers(client, QUERY)

    with pytest.raises(FareError) as caught:
        asyncio.run(run())
    assert caught.value.code == "unreachable"
    assert caught.value.message.rstrip().endswith("ReadTimeout")
