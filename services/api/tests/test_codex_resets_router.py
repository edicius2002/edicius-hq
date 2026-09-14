from fastapi.testclient import TestClient

from app.adapters.codex_resets import CodexResetsProviderError
from app.main import app
from tests.test_codex_resets_cache import snapshot

client = TestClient(app)


class AnsweringCache:
    def __init__(self, answer):
        self.answer = answer

    async def fetch(self, factory):
        if isinstance(self.answer, Exception):
            raise self.answer
        return self.answer


def test_route_exposes_the_normalized_snapshot_and_staleness(monkeypatch):
    from app.routers import codex_resets

    stale = snapshot()
    monkeypatch.setattr(codex_resets, "CACHE", AnsweringCache(stale))

    response = client.get("/api/codex-resets")

    assert response.status_code == 200
    assert response.json()["latestReset"]["id"] == "reset-1"
    assert response.json()["stats"]["total"] == 1
    assert response.json()["resets"][0]["resetType"] == "regular"
    assert response.json()["source"] == "codex-resets.com"


def test_route_preserves_retry_after_without_fabricating_an_empty_payload(monkeypatch):
    from app.routers import codex_resets

    monkeypatch.setattr(
        codex_resets,
        "CACHE",
        AnsweringCache(
            CodexResetsProviderError(
                "rate-limited",
                "slow down",
                transient=True,
                retry_after_seconds=75,
            )
        ),
    )

    response = client.get("/api/codex-resets")

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "75"
    assert "resets" not in response.json()
