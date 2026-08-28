import json
from fastapi.testclient import TestClient
from app.config import tweets_dir
from app.main import app
client=TestClient(app)
def test_tweets_maps_and_skips_corrupt_rows():
    tweets_dir().mkdir(parents=True)
    (tweets_dir()/"sample.jsonl").write_text("\n".join([json.dumps({"id":"1","date":"2026-01-01","text":"anon","is_reply":True,"in_reply_to_username":"other","like_count":2,"retweet_count":3,"reply_count":4,"url":"https://x.com/a/status/1"}),"bad"]))
    tweet = client.get("/api/tweets/sample").json()["tweets"][0]
    assert tweet["isReply"] is True
    assert tweet["likeCount"] == 2
    assert tweet["inReplyToUsername"] == "other"

def test_missing_tweets_are_empty():
    assert client.get("/api/tweets/missing").json()=={"handle":"missing","tweets":[]}

def test_tweets_sort_descending_before_limit():
    tweets_dir().mkdir(parents=True)
    rows = [
        {"id":"old","date":"Thu Aug 28 01:54:00 +0000 2026","text":"old"},
        {"id":"new","date":"Fri Aug 28 05:21:12 +0000 2026","text":"new"},
        {"id":"middle","date":"Fri Aug 28 05:21:01 +0000 2026","text":"middle"},
    ]
    (tweets_dir()/"ordered.jsonl").write_text("\n".join(json.dumps(row) for row in rows))
    response = client.get("/api/tweets/ordered?limit=2")
    assert [tweet["id"] for tweet in response.json()["tweets"]] == ["new", "middle"]
