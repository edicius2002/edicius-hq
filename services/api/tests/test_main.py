from unittest.mock import Mock

from fastapi.testclient import TestClient

from app.main import app
from app.routers.tweets import DEFAULT_HANDLE


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
