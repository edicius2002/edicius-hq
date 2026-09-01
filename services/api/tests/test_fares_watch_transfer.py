"""Portable exports of watched airfare routes and their observations."""

import gzip
import json

from fastapi.testclient import TestClient

from app.adapters.fares.models import FareOffer, FareSnapshot
from app.main import app
from app.routers import fares as fares_router
from app.services import kv_store
from app.services.fare_history import FareHistory


def _snapshot() -> FareSnapshot:
    return FareSnapshot(
        captured_at="2026-08-31T12:00:00Z",
        source="google-flights",
        origin="LIM",
        destination="CUZ",
        flight_date="2026-10-16",
        return_date=None,
        currency="USD",
        insights=None,
        offers=[
            FareOffer(
                airline="LA",
                airline_name="LATAM",
                flight_number="529",
                departure_at="2026-10-16T08:00",
                arrival_at="2026-10-16T09:30",
                transfers=0,
                duration_minutes=90,
                price=120.0,
                currency="USD",
                via_points=None,
            )
        ],
    )


def _watch() -> dict[str, object]:
    return {
        "version": 1,
        "routes": [
            {
                "origin": "LIM",
                "destination": "CUZ",
                "months": ["2026-10"],
                "currency": "USD",
            }
        ],
    }


def test_importing_the_same_export_twice_does_not_append_duplicate_observations(
    monkeypatch, tmp_path
):
    """Removing the dedupe key would make the second import grow the JSONL file."""
    history = FareHistory(tmp_path / "fares")
    monkeypatch.setattr(fares_router, "HISTORY", history)
    monkeypatch.setattr(kv_store, "kv_dir", lambda: tmp_path / "kv")
    kv_store.put_value("airfare-routes", _watch())
    history.append(_snapshot())
    client = TestClient(app)

    exported = client.get("/api/fares/watch/export")
    assert exported.status_code == 200
    assert exported.headers["content-type"].startswith("application/gzip")
    assert exported.headers["content-disposition"].startswith(
        'attachment; filename="airfare-watch-'
    )
    bundle = json.loads(gzip.decompress(exported.content))
    assert bundle["app"] == "edicius-hq"
    assert bundle["kind"] == "airfare-watch"
    assert bundle["version"] == 1
    assert bundle["routes"] == _watch()["routes"]
    assert list(bundle["history"]) == ["LIM-CUZ"]
    assert bundle["history"]["LIM-CUZ"][0]["flightDate"] == "2026-10-16"

    kv_store.put_value("airfare-routes", {"version": 1, "routes": []})
    (history.directory / "LIM-CUZ.jsonl").unlink()

    first = client.post(
        "/api/fares/watch/import",
        files={"file": ("airfare-watch.json.gz", exported.content, "application/gzip")},
    )
    assert first.status_code == 200
    assert first.json() == {
        "routesAdded": 1,
        "routesUpdated": 0,
        "observationsImported": 1,
        "observationsSkipped": 0,
        "invalidRows": 0,
    }
    archive = history.directory / "LIM-CUZ.jsonl"
    first_size = archive.stat().st_size

    second = client.post(
        "/api/fares/watch/import",
        files={"file": ("airfare-watch.json.gz", exported.content, "application/gzip")},
    )
    assert second.status_code == 200
    assert second.json()["observationsImported"] == 0
    assert second.json()["routesAdded"] == 0
    assert archive.stat().st_size == first_size


def test_wrong_transfer_envelope_fails_before_writing_routes_or_history(monkeypatch, tmp_path):
    """Accepting another document kind would let an import overwrite this watchlist."""
    history = FareHistory(tmp_path / "fares")
    monkeypatch.setattr(fares_router, "HISTORY", history)
    monkeypatch.setattr(kv_store, "kv_dir", lambda: tmp_path / "kv")
    kv_store.put_value("airfare-routes", _watch())
    payload = json.dumps(
        {
            "app": "edicius-hq",
            "kind": "investing-positions",
            "version": 1,
            "exportedAt": "2026-08-31T12:00:00Z",
            "routes": [],
            "history": {},
        }
    ).encode()

    response = TestClient(app).post(
        "/api/fares/watch/import",
        files={"file": ("wrong.json", payload, "application/json")},
    )

    assert response.status_code == 400
    assert kv_store.get_value("airfare-routes") == _watch()
    assert not history.directory.exists()


def test_import_unions_route_months_and_keeps_unmentioned_local_routes(monkeypatch, tmp_path):
    """Replacing instead of merging would erase a local watch absent from the file."""
    history = FareHistory(tmp_path / "fares")
    monkeypatch.setattr(fares_router, "HISTORY", history)
    monkeypatch.setattr(kv_store, "kv_dir", lambda: tmp_path / "kv")
    kv_store.put_value(
        "airfare-routes",
        {
            "version": 1,
            "routes": [
                {"origin": "LIM", "destination": "CUZ", "months": ["2026-11"], "currency": "USD"},
                {"origin": "LIM", "destination": "SCL", "months": ["2026-12"], "currency": "USD"},
            ],
        },
    )
    payload = {
        "app": "edicius-hq",
        "kind": "airfare-watch",
        "version": 1,
        "exportedAt": "2026-08-31T12:00:00Z",
        "routes": _watch()["routes"],
        "history": {"LIM-CUZ": []},
    }

    response = TestClient(app).post(
        "/api/fares/watch/import",
        files={"file": ("airfare-watch.json", json.dumps(payload), "application/json")},
    )

    assert response.status_code == 200
    assert response.json()["routesUpdated"] == 1
    assert kv_store.get_value("airfare-routes")["routes"] == [
        {
            "origin": "LIM",
            "destination": "CUZ",
            "months": ["2026-10", "2026-11"],
            "currency": "USD",
        },
        {"origin": "LIM", "destination": "SCL", "months": ["2026-12"], "currency": "USD"},
    ]
