"""Black-box integrity tests for the history cache behind ``GET /history``.

The tests deliberately know nothing about the cache's types or method names.
They call the public endpoint and observe only its response plus reads of the
temporary archive file.  Every mutation is confined to ``tmp_path``.
"""

import json
import os
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers import fares as fares_router
from app.services.fare_history import FareHistory

HISTORY_URL = "/api/fares/history?origin=lim&destination=scl&departure=2027-03"


def offer_row(
    price: float | None,
    *,
    airline: str = "LA",
    flight_number: str = "529",
    departure_at: str = "2027-03-09T08:00",
) -> dict[str, object]:
    return {
        "airline": airline,
        "airlineName": "LATAM" if airline == "LA" else "Sky Airline",
        "flightNumber": flight_number,
        "departureAt": departure_at,
        "arrivalAt": "2027-03-09T12:00",
        "transfers": 0,
        "durationMinutes": 240,
        "price": price,
        "currency": "USD",
        "viaPoints": [],
    }


def snapshot_row(
    captured_at: str,
    price: float,
    *,
    flight_date: str = "2027-03-09",
    second_offer: bool = False,
) -> dict[str, object]:
    offers = [offer_row(price)]
    if second_offer:
        offers.append(
            offer_row(
                price + 15,
                airline="H2",
                flight_number="803",
                departure_at="2027-03-09T10:30",
            )
        )
    return {
        "capturedAt": captured_at,
        "source": "fixture",
        "origin": "LIM",
        "destination": "SCL",
        "flightDate": flight_date,
        "returnDate": None,
        "currency": "USD",
        "insights": {"typical": 225.0, "usualLow": 190.0, "usualHigh": 260.0},
        "offers": offers,
    }


def write_jsonl(path: Path, rows: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("".join(json.dumps(row) + "\n" for row in rows), encoding="utf-8")


@pytest.fixture
def history_endpoint(monkeypatch, tmp_path):
    history = FareHistory(tmp_path / "fares")
    monkeypatch.setattr(fares_router, "HISTORY", history)
    client = TestClient(app, raise_server_exceptions=False)
    with client:
        yield client, history


def test_public_contract_preserves_all_content_filters_and_order(history_endpoint):
    """Catch dropped/reordered offers, fields, baselines, health, or bounds."""
    client, history = history_endpoint
    older = snapshot_row("2026-08-01T09:00:00+00:00", 210.0, second_offer=True)
    newer = snapshot_row(
        "2026-08-20T09:00:00+00:00", 205.0, flight_date="2027-03-10"
    )
    outside = snapshot_row("2026-09-01T09:00:00+00:00", 199.0)
    write_jsonl(history.directory / "LIM-SCL.jsonl", [outside, newer, older])
    write_jsonl(
        history.directory / "baseline/LIM-SCL.jsonl",
        [
            {
                "flightDate": "2027-04-01",
                "date": "2026-08-01",
                "price": 999,
                "currency": "USD",
                "source": "fixture",
            },
            {
                "flightDate": "2027-03-10",
                "date": "2026-08-02",
                "price": 221,
                "currency": "USD",
                "source": "fixture",
            },
            {
                "flightDate": "2027-03-09",
                "date": "2026-08-01",
                "price": 211,
                "currency": "USD",
                "source": "fixture",
            },
        ],
    )
    write_jsonl(
        history.directory / "checks/LIM-SCL.jsonl",
        [
            {
                "at": "2026-08-20T10:00:00+00:00",
                "flightDate": "2027-03-10",
                "outcome": "error",
                "offers": 0,
                "errorCode": "temporary",
            },
            {
                "at": "2026-08-01T10:00:00+00:00",
                "flightDate": "2027-03-09",
                "outcome": "changed",
                "offers": 2,
            },
            {
                "at": "2026-08-25T10:00:00+00:00",
                "flightDate": "2027-04-01",
                "outcome": "changed",
                "offers": 1,
            },
        ],
    )
    history.airports_path.write_text(
        json.dumps(
            {
                "SCL": {
                    "code": "SCL",
                    "name": "Arturo Merino Benitez",
                    "city": "Santiago",
                    "country": "Chile",
                    "latitude": -33.393,
                    "longitude": -70.786,
                },
                "LIM": {
                    "code": "LIM",
                    "name": "Jorge Chavez",
                    "city": "Lima",
                    "country": "Peru",
                    "latitude": -12.022,
                    "longitude": -77.114,
                },
            }
        ),
        encoding="utf-8",
    )

    response = client.get(f"{HISTORY_URL}&since=2026-08-01&until=2026-08-31")

    assert response.status_code == 200
    assert response.json() == {
        "origin": "LIM",
        "destination": "SCL",
        "snapshots": [older, newer],
        "baseline": [
            {"flightDate": "2027-03-09", "date": "2026-08-01", "price": 211.0},
            {"flightDate": "2027-03-10", "date": "2026-08-02", "price": 221.0},
        ],
        "health": {
            "lastCheckedAt": "2026-08-20T10:00:00+00:00",
            "checks": 2,
            "changes": 1,
            "errors": 1,
        },
        "airports": [
            {
                "code": "LIM",
                "name": "Jorge Chavez",
                "city": "Lima",
                "country": "Peru",
                "latitude": -12.022,
                "longitude": -77.114,
            },
            {
                "code": "SCL",
                "name": "Arturo Merino Benitez",
                "city": "Santiago",
                "country": "Chile",
                "latitude": -33.393,
                "longitude": -70.786,
            },
        ],
    }


def test_unchanged_requests_hit_cache_and_append_invalidates(history_endpoint, monkeypatch):
    """Catch reparsing unchanged files or serving stale content after append."""
    client, history = history_endpoint
    archive = history.directory / "LIM-SCL.jsonl"
    first_row = snapshot_row("2026-08-01T09:00:00+00:00", 210.0)
    appended_row = snapshot_row("2026-08-02T09:00:00+00:00", 205.0)
    write_jsonl(archive, [first_row])
    original_open = Path.open
    reads = 0

    def counted_open(path, mode="r", *args, **kwargs):
        nonlocal reads
        if path == archive and mode == "r":
            reads += 1
        return original_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", counted_open)

    first = client.get(HISTORY_URL)
    repeated = client.get(HISTORY_URL)
    with original_open(archive, "a", encoding="utf-8") as handle:
        handle.write(json.dumps(appended_row) + "\n")
    after_append = client.get(HISTORY_URL)

    assert first.status_code == repeated.status_code == after_append.status_code == 200
    assert first.json() == repeated.json()
    assert first.json()["snapshots"] == [first_row]
    assert after_append.json()["snapshots"] == [first_row, appended_row]
    assert reads == 2


def test_creation_after_a_genuine_empty_response_is_observed(history_endpoint):
    """Catch permanently caching a missing archive as an empty route."""
    client, history = history_endpoint

    empty = client.get(HISTORY_URL)
    created_row = snapshot_row("2026-08-03T09:00:00+00:00", 208.0)
    write_jsonl(history.directory / "LIM-SCL.jsonl", [created_row])
    created = client.get(HISTORY_URL)

    assert empty.status_code == created.status_code == 200
    assert empty.json()["snapshots"] == []
    assert created.json()["snapshots"] == [created_row]


@pytest.mark.parametrize("mutation", ["replace", "truncate"])
def test_replace_or_truncate_invalidates_without_stale_rows(
    history_endpoint, monkeypatch, tmp_path, mutation
):
    """Catch identity checks that miss replacement or shrinking files."""
    client, history = history_endpoint
    archive = history.directory / "LIM-SCL.jsonl"
    first_row = snapshot_row("2026-08-01T09:00:00+00:00", 210.0)
    removed_row = snapshot_row("2026-08-02T09:00:00+00:00", 205.0)
    replacement_row = snapshot_row("2026-08-04T09:00:00+00:00", 207.0)
    write_jsonl(archive, [first_row, removed_row])
    original_open = Path.open
    reads = 0

    def counted_open(path, mode="r", *args, **kwargs):
        nonlocal reads
        if path == archive and mode == "r":
            reads += 1
        return original_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", counted_open)
    initial = client.get(HISTORY_URL)
    repeated = client.get(HISTORY_URL)
    if mutation == "replace":
        replacement = tmp_path / "replacement.jsonl"
        with original_open(replacement, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(replacement_row) + "\n")
        os.replace(replacement, archive)
    else:
        with original_open(archive, "w", encoding="utf-8") as handle:
            handle.write(json.dumps(first_row) + "\n")
    changed = client.get(HISTORY_URL)

    assert initial.json() == repeated.json()
    assert initial.json()["snapshots"] == [first_row, removed_row]
    assert changed.status_code == 200
    assert changed.json()["snapshots"] == (
        [replacement_row] if mutation == "replace" else [first_row]
    )
    assert reads == 2


def test_temporary_read_error_is_not_empty_and_later_request_recovers(
    history_endpoint, monkeypatch
):
    """Catch converting an inaccessible archive into a successful empty history."""
    client, history = history_endpoint
    archive = history.directory / "LIM-SCL.jsonl"
    row = snapshot_row("2026-08-01T09:00:00+00:00", 210.0)
    write_jsonl(archive, [row])
    original_open = Path.open
    fail_next_read = True

    def temporarily_unreadable(path, mode="r", *args, **kwargs):
        nonlocal fail_next_read
        if path == archive and mode == "r" and fail_next_read:
            fail_next_read = False
            raise OSError("temporary archive fault")
        return original_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", temporarily_unreadable)

    failed = client.get(HISTORY_URL)
    recovered = client.get(HISTORY_URL)

    assert failed.status_code >= 500
    assert recovered.status_code == 200
    assert recovered.json()["snapshots"] == [row]
