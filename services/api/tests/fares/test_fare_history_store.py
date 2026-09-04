"""
The archive: what `FareHistory` writes, and what it keeps when a provider refuses.

Out of `test_fares.py`. Keeping its promises when the upstream says no is most
of what this store is for, so that is most of what is tested here.
"""

import json
import logging

from conftest import offer, snapshot

from app.adapters.fares.models import FareSnapshot
from app.services.fare_history import FareHistory

# --- the archive -----------------------------------------------------------


def test_append_then_read_round_trips_a_snapshot(tmp_path):
    history = FareHistory(tmp_path)
    saved = FareSnapshot(
        captured_at="2026-08-17T12:00:00+00:00",
        source="google-flights",
        origin="LIM",
        destination="SCL",
        flight_date="2026-10-16",
        return_date=None,
        currency="USD",
        offers=[offer(125.0, via_points=("CUZ",)), offer(180.0)],
    )
    history.append(saved)

    read = history.read("LIM", "SCL")
    assert len(read) == 1
    assert read[0].captured_at == "2026-08-17T12:00:00+00:00"
    assert [o.price for o in read[0].offers] == [125.0, 180.0]
    assert [o.via_points for o in read[0].offers] == [("CUZ",), None]
    assert read[0].cheapest.price == 125.0


def test_a_pre_waypoints_snapshot_still_reads_without_route_details(tmp_path):
    path = tmp_path / "LIM-SCL.jsonl"
    path.write_text(
        json.dumps(
            {
                "capturedAt": "2026-08-17T12:00:00+00:00",
                "source": "google-flights",
                "origin": "LIM",
                "destination": "SCL",
                "flightDate": "2026-10-16",
                "returnDate": None,
                "currency": "USD",
                "insights": None,
                "offers": [
                    {
                        "airline": "LA",
                        "airlineName": "LATAM",
                        "flightNumber": "529",
                        "departureAt": "2026-10-16T08:00",
                        "arrivalAt": "2026-10-16T12:00",
                        "transfers": 0,
                        "durationMinutes": 240,
                        "price": 125.0,
                        "currency": "USD",
                    }
                ],
            }
        )
        + "\n",
        encoding="utf-8",
    )

    assert FareHistory(tmp_path).read("LIM", "SCL")[0].offers[0].via_points is None


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
