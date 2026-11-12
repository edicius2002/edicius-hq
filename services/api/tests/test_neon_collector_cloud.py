"""Fail-closed configuration for the server-only Neon collector boundary."""

from __future__ import annotations

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
