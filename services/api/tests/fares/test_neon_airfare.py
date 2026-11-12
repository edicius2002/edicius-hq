"""The Neon Airfare writer keeps the existing sync contract server-side."""

from __future__ import annotations

from psycopg.types.json import Jsonb

from app.config import airfare_supabase_config, airfare_sync_backend
from app.services.airfare_data import _configured_airfare_data
from app.services.neon_airfare import NeonAirfare


def test_neon_writer_upserts_only_an_allowlisted_table_and_conflict(monkeypatch):
    client = NeonAirfare("postgresql://test:example@ep-test.neon.tech/db")
    calls = []
    monkeypatch.setattr(
        client, "_query", lambda statement, values=(): calls.append((statement, values)) or []
    )

    client.upsert(
        "fare_airports",
        [{"code": "AAA", "name": "Example", "payload": {"code": "AAA"}}],
        on_conflict="code",
    )

    assert len(calls) == 1
    assert any(isinstance(value, Jsonb) for value in calls[0][1])
    try:
        client.upsert("fare_airports", [{"code": "AAA"}], on_conflict="record_id")
    except ValueError:
        pass
    else:
        raise AssertionError("wrong conflict target accepted")


def test_neon_writer_rpc_contracts_and_verification_select(monkeypatch):
    client = NeonAirfare("postgresql://test:example@ep-test.neon.tech/db")
    calls = []

    def query(statement, values=()):
        calls.append((statement, values))
        return [{"value": []}] if "manifest" in str(statement) else []

    monkeypatch.setattr(client, "_query", query)
    assert client.rpc("airfare_dataset_manifest", {}) == []
    assert client.rpc("list_fare_projection_dirty_routes", {}) == []
    assert client.select_all("fare_snapshots", ("record_id",), key="record_id") == []
    assert len(calls) == 3


def test_local_airfare_can_select_neon_sync_without_supabase_credentials(monkeypatch):
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "local")
    monkeypatch.setenv("AIRFARE_SYNC_ENABLED", "true")
    monkeypatch.setenv("AIRFARE_SYNC_BACKEND", "neon")
    monkeypatch.setenv("DATABASE_URL", "postgresql://test:example@ep-test.neon.tech/db")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    assert airfare_sync_backend() == "neon"
    assert airfare_supabase_config() is None
    assert isinstance(_configured_airfare_data()._remote, NeonAirfare)
