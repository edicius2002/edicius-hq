"""Fail-closed configuration for the server-only Neon collector boundary."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

import pytest

from app.services.collector_cloud import new_collector_cloud
from app.services.neon_collector_cloud import NeonCollectorCloud


def test_neon_collector_does_not_need_supabase_service_credentials(monkeypatch):
    monkeypatch.setenv("COLLECTOR_DATA_BACKEND", "neon")
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:password@ep-test.neon.tech/neondb")
    monkeypatch.setenv("EDICIUS_OWNER_ID", "11111111-1111-1111-1111-111111111111")
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)

    client = new_collector_cloud()

    assert isinstance(client, NeonCollectorCloud)
    client.close()


def test_neon_collector_requires_its_own_server_only_url(monkeypatch):
    monkeypatch.setenv("COLLECTOR_DATA_BACKEND", "neon")
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.setenv("EDICIUS_OWNER_ID", "11111111-1111-1111-1111-111111111111")

    with pytest.raises(ValueError, match="DATABASE_URL"):
        new_collector_cloud()


def test_neon_collector_rejects_non_neon_hosts(monkeypatch):
    monkeypatch.setenv("COLLECTOR_DATA_BACKEND", "neon")
    monkeypatch.setenv("DATABASE_URL", "postgresql://user:password@invalid.example/db")
    monkeypatch.setenv("EDICIUS_OWNER_ID", "11111111-1111-1111-1111-111111111111")

    with pytest.raises(ValueError, match="Neon Postgres"):
        new_collector_cloud()


def test_neon_fx_history_pages_by_full_key_and_owner(monkeypatch):
    owner = UUID("11111111-1111-1111-1111-111111111111")
    client = NeonCollectorCloud("postgresql://user:secret@ep-test.neon.tech/neondb", owner)
    captured = []
    effective = datetime(2026, 10, 1, 5, tzinfo=UTC)
    observed = datetime(2026, 10, 1, 6, tzinfo=UTC)

    def execute(query, values=()):
        captured.append((query, values))
        return [
            dict(
                owner_id=owner,
                source="kambista",
                effective_at=effective,
                observed_at=observed,
                buy="3.4",
                sell="3.5",
                context={},
            )
        ]

    monkeypatch.setattr(client, "_execute", execute)
    assert client._project_url == "https://ep-test.neon.tech"
    rows = client.list_fx(after=("kambista", effective.isoformat(), effective.isoformat()), limit=1)
    assert rows[0]["observed_at"] == "2026-10-01T06:00:00.000000+00:00"
    query, values = captured[0]
    assert "owner_id=%s::uuid" in query
    assert "effective_at >= %s::timestamptz" in query
    assert "(source,effective_at,observed_at) >" in query
    assert "ORDER BY source,effective_at,observed_at LIMIT %s" in query
    assert values[0] == str(owner)
    assert values[-1] == 1
