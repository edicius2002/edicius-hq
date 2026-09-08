import json
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.adapters.cnn_sentiment import (
    SentimentPayloadError,
    SentimentProviderError,
    parse_sentiment,
)
from app.main import app
from app.routers import sentiment as sentiment_router

FIXTURE = Path(__file__).parent / "fixtures" / "cnn_sentiment_synthetic.json"
client = TestClient(app)


def a_snapshot(*, stale: bool = False):
    snapshot = parse_sentiment(
        json.loads(FIXTURE.read_text(encoding="utf-8")),
        fetched_at=datetime(2026, 1, 3, 1, tzinfo=UTC),
    )
    return snapshot.as_stale() if stale else snapshot


def test_returns_the_complete_normalized_snapshot(monkeypatch):
    async def answer(factory):
        return a_snapshot()

    monkeypatch.setattr(sentiment_router.CACHE, "fetch", answer)

    response = client.get("/api/sentiment")

    assert response.status_code == 200
    body = response.json()
    assert body["source"] == "cnn"
    assert body["stale"] is False
    assert body["asOf"] == "2026-01-02T23:59:55Z"
    assert body["composite"]["label"] == "Fear & Greed Index"
    assert len(body["indicators"]) == 7
    assert len(body["indicators"][0]["series"]) == 2


def test_preserves_the_cache_stale_flag(monkeypatch):
    async def answer(factory):
        return a_snapshot(stale=True)

    monkeypatch.setattr(sentiment_router.CACHE, "fetch", answer)

    assert client.get("/api/sentiment").json()["stale"] is True


def test_exposes_mirror_provenance_in_the_same_normalized_contract(monkeypatch):
    async def answer(factory):
        return replace(a_snapshot(), source="cnn-mirror")

    monkeypatch.setattr(sentiment_router.CACHE, "fetch", answer)

    response = client.get("/api/sentiment")

    assert response.status_code == 200
    assert response.json()["source"] == "cnn-mirror"
    assert len(response.json()["indicators"]) == 7


@pytest.mark.parametrize(
    ("error", "status_code", "code"),
    [
        (
            SentimentProviderError("rate-limited", "slow down", transient=True),
            429,
            "rate-limited",
        ),
        (
            SentimentProviderError("access-refused", "refused", transient=True),
            503,
            "access-refused",
        ),
        (
            SentimentProviderError("unreachable", "offline", transient=True),
            503,
            "unreachable",
        ),
        (SentimentPayloadError("schema changed"), 502, "invalid-payload"),
        (
            SentimentProviderError("upstream-error", "failed", transient=True),
            502,
            "upstream-error",
        ),
    ],
)
def test_maps_provider_errors_without_blank_data(monkeypatch, error, status_code, code):
    async def refuse(factory):
        raise error

    monkeypatch.setattr(sentiment_router.CACHE, "fetch", refuse)

    response = client.get("/api/sentiment")

    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code
    assert response.json()["detail"]["message"] == error.message


@pytest.mark.unauthenticated
def test_requires_a_session():
    assert client.get("/api/sentiment").status_code == 401
