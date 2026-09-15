"""Portable exports of watched airfare routes and their observations."""

import gzip
import json
from dataclasses import replace
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app.adapters.fares.models import FareOffer, FareSnapshot
from app.main import app
from app.routers import fares as fares_router
from app.services.airfare_data import AirfareData, ImportSnapshotsResult
from app.services import kv_store
from app.services.fare_calendar import FareCalendar
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


def _local_data(history: FareHistory, tmp_path) -> AirfareData:
    return AirfareData(history, FareCalendar(tmp_path / "calendar"), source_root=tmp_path)


def test_export_exposes_its_filename_to_the_cross_origin_browser(monkeypatch, tmp_path):
    """Without this CORS header the SPA can download bytes but cannot read the dated name."""
    history = FareHistory(tmp_path / "fares")
    monkeypatch.setattr(fares_router, "AIRFARE_DATA", _local_data(history, tmp_path))
    monkeypatch.setattr(kv_store, "kv_dir", lambda: tmp_path / "kv")
    kv_store.put_value("airfare-routes", _watch())

    response = TestClient(app).get(
        "/api/fares/watch/export",
        headers={"Origin": "http://localhost:5173"},
    )

    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://localhost:5173"
    exposed = {
        name.strip().casefold()
        for name in response.headers["access-control-expose-headers"].split(",")
    }
    assert "content-disposition" in exposed


def test_importing_the_same_export_twice_does_not_append_duplicate_observations(
    monkeypatch, tmp_path
):
    """Removing the dedupe key would make the second import grow the JSONL file."""
    history = FareHistory(tmp_path / "fares")
    monkeypatch.setattr(fares_router, "AIRFARE_DATA", _local_data(history, tmp_path))
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
    calls: list[str] = []

    class NoImportFacade:
        def import_snapshots(self, snapshots):
            calls.append("import")
            raise AssertionError("a malformed envelope must not reach the data façade")

        def sync_incremental(self):
            calls.append("sync")
            raise AssertionError("a malformed envelope must not synchronize")

    monkeypatch.setattr(fares_router, "AIRFARE_DATA", NoImportFacade())
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
    assert calls == []


def test_import_unions_route_months_and_keeps_unmentioned_local_routes(monkeypatch, tmp_path):
    """Replacing instead of merging would erase a local watch absent from the file."""
    history = FareHistory(tmp_path / "fares")
    monkeypatch.setattr(fares_router, "AIRFARE_DATA", _local_data(history, tmp_path))
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


def test_export_streams_every_snapshot_the_data_facade_yields(monkeypatch, tmp_path):
    """Catch an export that truncates a complete façade iterator."""

    snapshots = [
        replace(_snapshot(), captured_at=f"2026-08-{index // 24 + 1:02d}T{index % 24:02d}:00:00Z")
        for index in range(501)
    ]

    class ExportFacade:
        def __init__(self) -> None:
            self.queries: list[tuple[str, str]] = []

        def iter_snapshots(self, origin: str, destination: str):
            self.queries.append((origin, destination))
            yield from snapshots

    facade = ExportFacade()
    monkeypatch.setattr(fares_router, "AIRFARE_DATA", facade, raising=False)
    monkeypatch.setattr(kv_store, "kv_dir", lambda: tmp_path / "kv")
    kv_store.put_value("airfare-routes", _watch())

    response = TestClient(app).get("/api/fares/watch/export")

    exported = json.loads(gzip.decompress(response.content))
    assert response.status_code == 200
    assert facade.queries == [("LIM", "CUZ")]
    assert [row["capturedAt"] for row in exported["history"]["LIM-CUZ"]] == [
        snapshot.captured_at for snapshot in snapshots
    ]


def test_import_persists_before_a_failed_incremental_sync_and_remains_exportable(
    monkeypatch, tmp_path
):
    """Catch a replica failure that runs before or undoes the local watch import."""

    class ImportFacade:
        def __init__(self) -> None:
            self.events: list[str] = []
            self.snapshots = []

        def import_snapshots(self, snapshots):
            imported = list(snapshots)
            self.events.append("import")
            self.snapshots.extend(imported)
            return ImportSnapshotsResult(imported=len(imported), skipped=0)

        def sync_incremental(self):
            self.events.append("sync")
            return SimpleNamespace(status="failed")

        def iter_snapshots(self, origin: str, destination: str):
            assert (origin, destination) == ("LIM", "CUZ")
            yield from self.snapshots

    facade = ImportFacade()
    payload = {
        "app": "edicius-hq",
        "kind": "airfare-watch",
        "version": 1,
        "exportedAt": "2026-08-31T12:00:00Z",
        "routes": _watch()["routes"],
        "history": {"LIM-CUZ": [fares_router._snapshot_row(_snapshot())]},
    }
    monkeypatch.setattr(fares_router, "AIRFARE_DATA", facade, raising=False)
    monkeypatch.setattr(kv_store, "kv_dir", lambda: tmp_path / "kv")
    kv_store.put_value("airfare-routes", {"version": 1, "routes": []})

    client = TestClient(app)
    imported = client.post(
        "/api/fares/watch/import",
        files={"file": ("airfare-watch.json", json.dumps(payload), "application/json")},
    )
    exported = client.get("/api/fares/watch/export")

    assert imported.json()["observationsImported"] == 1
    assert facade.events == ["import", "sync"]
    assert json.loads(gzip.decompress(exported.content))["history"]["LIM-CUZ"] == [
        fares_router._snapshot_row(_snapshot())
    ]


def test_import_without_new_observations_does_not_start_an_incremental_sync(monkeypatch, tmp_path):
    """Catch a no-op import that needlessly attempts a replica write."""

    class ExistingFacade:
        def __init__(self) -> None:
            self.imports = 0

        def import_snapshots(self, snapshots):
            assert list(snapshots)
            self.imports += 1
            return ImportSnapshotsResult(imported=0, skipped=1)

        def sync_incremental(self):
            raise AssertionError("a no-op local import must not synchronize")

    facade = ExistingFacade()
    payload = {
        "app": "edicius-hq",
        "kind": "airfare-watch",
        "version": 1,
        "exportedAt": "2026-08-31T12:00:00Z",
        "routes": _watch()["routes"],
        "history": {"LIM-CUZ": [fares_router._snapshot_row(_snapshot())]},
    }
    monkeypatch.setattr(fares_router, "AIRFARE_DATA", facade)
    monkeypatch.setattr(kv_store, "kv_dir", lambda: tmp_path / "kv")
    kv_store.put_value("airfare-routes", _watch())

    response = TestClient(app).post(
        "/api/fares/watch/import",
        files={"file": ("airfare-watch.json", json.dumps(payload), "application/json")},
    )

    assert response.json()["observationsSkipped"] == 1
    assert facade.imports == 1
