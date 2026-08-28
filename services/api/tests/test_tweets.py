import asyncio
import json

from fastapi.testclient import TestClient

from app.config import tweets_dir
from app.main import app
from app.services.tweet_refresh import RUNNER

client = TestClient(app)

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


class _FakeProcess:
    """A scraper that prints the lines it was given and exits how it was told."""

    def __init__(self, lines: list[bytes], code: int) -> None:
        self._lines = lines
        self._code = code
        self.stdout = self

    def __aiter__(self):
        async def generate():
            for line in self._lines:
                yield line

        return generate()

    async def wait(self) -> int:
        return self._code


def _scraper(monkeypatch, tmp_path, lines: list[bytes], code: int) -> list[int]:
    """Put a fake scraper where the runner will look, and count its launches."""
    script = tmp_path / "tools" / "x-scraper"
    script.mkdir(parents=True)
    (script / "scrape.py").write_text("")
    monkeypatch.setenv("REPO_ROOT", str(tmp_path))
    launches: list[int] = []

    async def create(*_args, **_kwargs):
        launches.append(1)
        return _FakeProcess(lines, code)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)
    return launches


def _run(scenario) -> None:
    RUNNER.pass_ = None
    RUNNER.task = None
    asyncio.run(scenario())


def test_refresh_reads_the_scrapers_own_progress(monkeypatch, tmp_path):
    """Progress is parsed off the scraper's stdout rather than estimated."""
    _scraper(monkeypatch, tmp_path, [b"Progreso: scroll 7/200; nuevos 12; vistos 12.\n"], 0)

    async def scenario():
        RUNNER.start("sample")
        await RUNNER.task
        assert RUNNER.current().state == "finished"
        assert (RUNNER.current().scroll, RUNNER.current().new) == (7, 12)

    _run(scenario)


def test_refresh_will_not_open_a_second_browser(monkeypatch, tmp_path):
    """
    Two captures cannot share one profile.

    `launch_persistent_context` locks the profile directory, and a second
    process that opens it captures nothing at all — no error, no rows, just a
    run that reports zero. Measured live: a second scrape logged `nuevos 0` on
    every scroll while the first held the lock. So a second start has to answer
    with the run already going.
    """
    launches = _scraper(monkeypatch, tmp_path, [b"Progreso: scroll 1/200; nuevos 0; vistos 0.\n"], 0)

    async def scenario():
        first = RUNNER.start("sample")
        second = RUNNER.start("sample")
        assert second is first
        await RUNNER.task
        assert len(launches) == 1

    _run(scenario)


def test_refresh_reports_a_scraper_that_failed(monkeypatch, tmp_path):
    """A non-zero exit names the session, which is what usually went wrong."""
    _scraper(monkeypatch, tmp_path, [], 2)

    async def scenario():
        RUNNER.start("sample")
        await RUNNER.task
        assert RUNNER.current().state == "failed"
        assert "import_session.py" in RUNNER.current().error

    _run(scenario)


def test_refresh_says_where_the_scraper_should_have_been(monkeypatch, tmp_path):
    """A missing script names REPO_ROOT instead of surfacing a bare traceback."""
    monkeypatch.setenv("REPO_ROOT", str(tmp_path))

    async def scenario():
        RUNNER.start("sample")
        await RUNNER.task
        assert RUNNER.current().state == "failed"
        assert "REPO_ROOT" in RUNNER.current().error

    _run(scenario)


def test_refresh_endpoint_starts_a_run_and_answers_202(monkeypatch, tmp_path):
    _scraper(monkeypatch, tmp_path, [b"Progreso: scroll 3/200; nuevos 1; vistos 1.\n"], 0)
    RUNNER.pass_ = None
    RUNNER.task = None

    started = client.post("/api/tweets/sample/refresh")

    assert started.status_code == 202
    assert started.json()["state"] == "running"


def test_refresh_status_is_idle_for_a_handle_nobody_started(monkeypatch, tmp_path):
    """`idle` rather than 404: the page is asking whether anything is running."""
    RUNNER.pass_ = None
    RUNNER.task = None

    assert client.get("/api/tweets/nobody/refresh").json() == {
        "handle": "nobody",
        "state": "idle",
        "scroll": 0,
        "new": 0,
        "error": None,
        "finishedAt": None,
    }


def test_refresh_tells_the_scraper_where_this_api_reads(monkeypatch, tmp_path):
    """
    The destination is stated, not inferred twice.

    `scrape.py` derives its default from the repository layout and does not
    read `LOCAL_DATA_DIR`; `tweets_dir()` does. With that variable set the two
    disagreed, and a capture that reported `finished, new 6` wrote those rows
    into a file this API never reads.
    """
    script = tmp_path / "tools" / "x-scraper"
    script.mkdir(parents=True)
    (script / "scrape.py").write_text("")
    monkeypatch.setenv("REPO_ROOT", str(tmp_path))
    seen: dict[str, str] = {}

    async def create(*_args, **kwargs):
        seen.update(kwargs["env"])
        return _FakeProcess([], 0)

    monkeypatch.setattr(asyncio, "create_subprocess_exec", create)

    async def scenario():
        RUNNER.start("sample")
        await RUNNER.task

    _run(scenario)

    assert seen["X_SCRAPER_OUTPUT"] == str(tweets_dir())
