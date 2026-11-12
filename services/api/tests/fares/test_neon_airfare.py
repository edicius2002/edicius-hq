"""The Neon Airfare writer keeps the existing sync contract server-side."""

from __future__ import annotations

import pytest
from psycopg.types.json import Jsonb

from app.config import airfare_supabase_config, airfare_sync_backend
from app.services import neon_airfare
from app.services.airfare_data import _configured_airfare_data
from app.services.airfare_supabase import AirfareRemoteUnavailable
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
    assert "IS DISTINCT FROM" in calls[0][0].as_string()
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


def test_neon_writer_reuses_one_autocommit_connection_across_batches(monkeypatch):
    class Cursor:
        description = None

        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def execute(self, statement, values):
            statements.append((statement, values))

    class Connection:
        closed = False

        def cursor(self):
            return Cursor()

        def close(self):
            self.closed = True

    statements = []
    connections = []

    def connect(*_args, **kwargs):
        assert kwargs["autocommit"] is True
        connection = Connection()
        connections.append(connection)
        return connection

    monkeypatch.setattr(neon_airfare.psycopg, "connect", connect)
    writer = NeonAirfare("postgresql://test:example@ep-test.neon.tech/db")
    writer._query("SELECT 1")
    writer._query("SELECT 2")
    assert len(connections) == 1
    assert len(statements) == 2
    writer.close()
    assert writer.is_closed and connections[0].closed
    with pytest.raises(AirfareRemoteUnavailable):
        writer._query("SELECT 3")
