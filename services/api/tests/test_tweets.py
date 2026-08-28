import json
from fastapi.testclient import TestClient
from app.config import tweets_dir
from app.main import app
client=TestClient(app)
def test_tweets_maps_and_skips_corrupt_rows():
    tweets_dir().mkdir(parents=True)
    (tweets_dir()/"sample.jsonl").write_text("\n".join([json.dumps({"id":"1","date":"2026-01-01","text":"anon","is_reply":True,"in_reply_to_username":"other","like_count":2,"retweet_count":3,"reply_count":4,"url":"https://x.com/a/status/1"}),"bad",json.dumps({"id":"2","date":"2026-01-02","text":"two","is_reply":False,"like_count":0,"retweet_count":0,"reply_count":0,"url":"https://x.com/a/status/2"})]))
    assert client.get("/api/tweets/sample?limit=1").json()=={"handle":"sample","tweets":[{"id":"1","date":"2026-01-01","text":"anon","isReply":True,"inReplyToId":None,"inReplyToUsername":"other","likeCount":2,"retweetCount":3,"replyCount":4,"url":"https://x.com/a/status/1"}]}
def test_missing_tweets_are_empty():
    assert client.get("/api/tweets/missing").json()=={"handle":"missing","tweets":[]}
