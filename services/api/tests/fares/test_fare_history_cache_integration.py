"""Black-box integrity tests for the history cache behind ``GET /history``.

The tests deliberately know nothing about the cache's types or method names.
They call the public endpoint and observe only its response plus reads of the
temporary archive file.  Every mutation is confined to ``tmp_path``.
"""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from app.main import app
from app.routers import fares as fares_router
from app.services.fare_history import FareHistory
from fastapi.testclient import TestClient

HISTORY_URL = "/api/fares/history?origin=lim&destination=scl&departure=2027-03"
ROOT = Path(__file__).resolve().parents[4]


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


def file_bytes(root: Path) -> dict[str, bytes]:
    return {
        path.relative_to(root).as_posix(): path.read_bytes()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def load_script(name: str):
    path = ROOT / f"scripts/{name}.py"
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


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
    newer = snapshot_row("2026-08-20T09:00:00+00:00", 205.0, flight_date="2027-03-10")
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


def test_empty_until_remains_a_present_filter_after_warm_access(history_endpoint):
    """Catch treating ``until=`` as though the query parameter were absent."""
    client, history = history_endpoint
    row = snapshot_row("2026-08-01T09:00:00+00:00", 210.0)
    write_jsonl(history.directory / "LIM-SCL.jsonl", [row])

    warm = client.get(HISTORY_URL)
    empty_until = client.get(f"{HISTORY_URL}&until=")
    absent_again = client.get(HISTORY_URL)

    assert warm.status_code == empty_until.status_code == absent_again.status_code == 200
    assert warm.json()["snapshots"] == [row]
    assert empty_until.json()["snapshots"] == []
    assert absent_again.json()["snapshots"] == [row]


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


def test_measurement_freezes_source_and_reports_each_access_phase(tmp_path):
    """Catch measuring a moving source or collapsing distinct cache phases."""
    source = tmp_path / "source"
    archive = source / "fares/LIM-SCL.jsonl"
    write_jsonl(
        archive,
        [
            snapshot_row("2026-08-01T09:00:00+00:00", 210.0),
            snapshot_row("2026-08-02T09:00:00+00:00", 205.0),
        ],
    )
    write_jsonl(
        source / "fares/baseline/LIM-SCL.jsonl",
        [
            {
                "flightDate": "2027-03-09",
                "date": "2026-08-01",
                "price": 211,
                "currency": "USD",
                "source": "fixture",
            }
        ],
    )
    write_jsonl(
        source / "fares/checks/LIM-SCL.jsonl",
        [
            {
                "at": "2026-08-01T10:00:00+00:00",
                "flightDate": "2027-03-09",
                "outcome": "changed",
                "offers": 1,
            }
        ],
    )
    (source / "fares/airports.json").write_text("{}", encoding="utf-8")
    watchlist = source / "kv/airfare-routes.json"
    watchlist.parent.mkdir(parents=True)
    watchlist.write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "origin": "LIM",
                        "destination": "SCL",
                        "months": ["2027-03"],
                        "currency": "USD",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    before = file_bytes(source)
    output = tmp_path / "measurement.json"
    frozen = tmp_path / "frozen"
    work = tmp_path / "work"

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/measure_airfare.py"),
            "--data-dir",
            str(source),
            "--frozen-copy",
            str(frozen),
            "--work-dir",
            str(work),
            "--pair",
            "LIM-SCL",
            "--samples",
            "2",
            "--output",
            str(output),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    report = json.loads(output.read_text(encoding="utf-8"))
    phases = report["routes"][0]["history"]["phases"]
    assert report["method"] == (
        "Direct production history endpoint model construction only; excludes "
        "Pydantic JSON serialization, HTTP, authentication, browser, collector "
        "startup, and source writes"
    )
    assert report["timing_boundaries"] == {
        "included": [
            "production get_history function",
            "history read or cache lookup",
            "response-model construction",
        ],
        "excluded": [
            "model_dump_json serialization",
            "HTTP stack",
            "authentication",
            "browser rendering",
            "WAN latency",
            "collector startup and work",
        ],
    }
    assert file_bytes(source) == before
    assert report["dataset"]["frozen_copy"] == str(frozen.resolve())
    assert report["dataset"]["sha256"]
    assert set(phases) == {
        "first_process_access",
        "unchanged_repetitions",
        "after_append",
        "after_replace",
        "after_truncate",
    }
    assert phases["first_process_access"]["content"]["snapshots"] == 2
    assert phases["unchanged_repetitions"]["content"]["snapshots"] == 2
    assert len(phases["unchanged_repetitions"]["samples_ms"]) == 2
    assert phases["after_append"]["content"]["snapshots"] == 3
    assert phases["after_replace"]["content"]["snapshots"] == 2
    assert phases["after_truncate"]["content"]["snapshots"] == 1
    for phase in phases.values():
        assert len(phase["response_sha256"]) == 64
        assert phase["archive_reads"] >= 0
        assert phase["peak_traced_bytes"] >= 0

    baseline_phase = report["routes"][0]["history"]["phases"]["unchanged_repetitions"]
    baseline_phase["timing"]["median_ms"] = 20.0
    baseline_phase["archive_reads"] = 2
    output.write_text(json.dumps(report), encoding="utf-8")
    optimized = json.loads(json.dumps(report))
    optimized["commit"] = "optimized-fixture"
    optimized_phase = optimized["routes"][0]["history"]["phases"]["unchanged_repetitions"]
    optimized_phase["timing"]["median_ms"] = 10.0
    optimized_phase["archive_reads"] = 0
    optimized_phase["peak_traced_bytes"] = 1000
    optimized_output = tmp_path / "optimized.json"
    optimized_output.write_text(json.dumps(optimized), encoding="utf-8")
    comparison_output = tmp_path / "comparison.json"

    subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts/measure_airfare.py"),
            "--compare",
            str(output),
            str(optimized_output),
            "--output",
            str(comparison_output),
        ],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )

    comparison = json.loads(comparison_output.read_text(encoding="utf-8"))
    repeated = comparison["routes"][0]["phases"]["unchanged_repetitions"]
    assert comparison["metric"] == "direct_endpoint_model_construction_ms"
    assert comparison["timing_boundaries"] == report["timing_boundaries"]
    assert comparison["dataset_sha256"] == report["dataset"]["sha256"]
    assert comparison["content_equivalent"] is True
    assert comparison["optimized_commit"] == "optimized-fixture"
    assert repeated["optimized"]["archive_reads"] == 0
    assert repeated["baseline"]["archive_reads"] == 2
    assert repeated["median_change_percent"] < 0


def test_browser_replay_metadata_prevents_wan_or_end_to_end_interpretation(tmp_path):
    """Catch browser results reported without their local-replay boundaries."""
    browser_measurement = load_script("measure_airfare_browser")
    build = tmp_path / "build"
    payloads = tmp_path / "payloads"
    build.mkdir()
    payloads.mkdir()
    (build / "index.html").write_text("<main>fixture</main>", encoding="utf-8")
    (payloads / "LIM-SCL-history.json").write_text("{}", encoding="utf-8")

    metadata = browser_measurement.measurement_metadata({"commit": "abc123"}, build, payloads)

    assert metadata["kind"] == "local_response_replay"
    assert metadata["source_measurement_commit"] == "abc123"
    assert metadata["launch"] == {
        "browser": "chromium",
        "headless": True,
        "chromium_args": ["--disable-gpu", "--disable-software-rasterizer"],
        "viewport": {"width": 1440, "height": 1000},
        "reduced_motion": "reduce",
    }
    assert metadata["timing_boundaries"] == {
        "flights_ready_ms": "navigation start through table readiness and two paint frames",
        "moves_switch_ms": "chart-button click through two paint frames",
        "excluded": [
            "backend computation",
            "production authentication",
            "collector work",
            "WAN transfer",
            "application shell",
        ],
    }
    assert metadata["interpretation"] == (
        "Local loopback replay of prepared gzip responses; not WAN or end-to-end latency."
    )
    assert len(metadata["build_sha256"]) == 64
    assert len(metadata["payload_sha256"]) == 64
