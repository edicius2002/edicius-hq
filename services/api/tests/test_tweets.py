import json

from fastapi.testclient import TestClient

from app.config import tweets_dir
from app.main import app
from app.services.tweet_watcher import RUNNER, Refresh

client = TestClient(app)


def test_tweets_maps_and_skips_corrupt_rows():
    tweets_dir().mkdir(parents=True)
    (tweets_dir() / "sample.jsonl").write_text(
        "\n".join(
            [
                json.dumps(
                    {
                        "id": "1",
                        "date": "2026-01-01",
                        "text": "anon",
                        "is_reply": True,
                        "like_count": 2,
                    }
                ),
                "bad",
            ]
        )
    )
    tweet = client.get("/api/tweets/sample").json()["tweets"][0]
    assert tweet["isReply"] is True
    assert "likeCount" not in tweet


def test_tweets_sort_descending_before_limit():
    tweets_dir().mkdir(parents=True)
    rows = [
        {"id": "old", "date": "Thu Aug 28 01:54:00 +0000 2026"},
        {"id": "new", "date": "Fri Aug 28 05:21:12 +0000 2026"},
    ]
    (tweets_dir() / "ordered.jsonl").write_text("\n".join(json.dumps(row) for row in rows))
    assert [
        tweet["id"] for tweet in client.get("/api/tweets/ordered?limit=1").json()["tweets"]
    ] == ["new"]


def test_refresh_delegates_to_the_profile_owner(monkeypatch):
    refresh = Refresh(handle="sample", state="running")
    monkeypatch.setattr(RUNNER, "refresh", lambda handle: refresh)
    response = client.post("/api/tweets/sample/refresh")
    assert response.status_code == 202
    assert response.json()["state"] == "running"


def test_watch_endpoint_starts_one_owner(monkeypatch):
    watch = Refresh(handle="sample", state="watching")
    monkeypatch.setattr(RUNNER, "watch", lambda handle: watch)
    response = client.post("/api/tweets/sample/watch")
    assert response.status_code == 202
    assert response.json()["state"] == "watching"
