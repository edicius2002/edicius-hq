from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.routers.tweets import DEFAULT_HANDLE
from app.services import airfare_supabase


def test_lifespan_starts_default_tweet_watcher_when_enabled(monkeypatch):
    """Catches removal of the API-owned watcher startup."""
    watch = Mock()
    monkeypatch.setenv("X_TWEET_WATCH_ON_START", "true")
    monkeypatch.setattr("app.main.TWEET_WATCHER.watch", watch)

    with TestClient(app):
        pass

    watch.assert_called_once_with(DEFAULT_HANDLE)


def test_lifespan_does_not_start_tweet_watcher_when_disabled(monkeypatch):
    """Catches a disabled deployment still opening the X browser."""
    watch = Mock()
    monkeypatch.setenv("X_TWEET_WATCH_ON_START", "false")
    monkeypatch.setattr("app.main.TWEET_WATCHER.watch", watch)

    with TestClient(app):
        pass

    watch.assert_not_called()


def test_lifespan_closes_the_configured_airfare_supabase_client_once(monkeypatch):
    """Catches a process shutdown leaking the reusable Supabase HTTP client."""
    client = Mock()
    monkeypatch.setattr(airfare_supabase, "_configured_client", client)

    with TestClient(app):
        pass

    client.close.assert_called_once_with()


@pytest.mark.parametrize(
    ("backend", "sync_enabled", "missing"),
    [
        ("supabase", "false", "SUPABASE_URL"),
        ("supabase", "false", "SUPABASE_SECRET_KEY"),
        ("local", "true", "SUPABASE_URL"),
        ("local", "true", "SUPABASE_SECRET_KEY"),
    ],
)
def test_lifespan_rejects_enabled_airfare_cloud_features_without_each_required_variable(
    monkeypatch, backend, sync_enabled, missing
):
    """Catches a remotely configured API claiming healthy before it can use Supabase."""
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", backend)
    monkeypatch.setenv("AIRFARE_SYNC_ENABLED", sync_enabled)
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-startup-secret")
    monkeypatch.delenv(missing, raising=False)

    with pytest.raises(ValueError, match=missing), TestClient(app):
        pass


def test_lifespan_rejects_an_enabled_airfare_cloud_feature_with_a_bad_host(monkeypatch):
    """Catches startup deferring project-host validation until the first sync or read."""
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "supabase")
    monkeypatch.setenv("AIRFARE_SYNC_ENABLED", "false")
    monkeypatch.setenv("SUPABASE_URL", "https://not-a-project.invalid")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-startup-secret")

    with pytest.raises(ValueError, match="Supabase URL"), TestClient(app):
        pass


def test_lifespan_local_airfare_mode_ignores_malformed_cloud_credentials(monkeypatch):
    """Catches the one-restart local rollback path validating unused cloud values."""
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "local")
    monkeypatch.setenv("AIRFARE_SYNC_ENABLED", "false")
    monkeypatch.setenv("SUPABASE_URL", "not even a URL")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "ignored-local-secret")

    with TestClient(app):
        pass
