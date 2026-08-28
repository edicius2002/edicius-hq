import asyncio
import sys
import threading
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "tools" / "x-scraper"))

from x_scraper import is_timeline_url

from app.services import tweet_watcher
from app.services.tweet_watcher import (
    BrowserLoop,
    TweetWatcher,
    _loop_factory,
    should_stop_scrolling,
)


def test_loop_factory_uses_a_proactor_loop_on_windows(monkeypatch):
    expected = object()
    monkeypatch.setattr(tweet_watcher.sys, "platform", "win32")
    monkeypatch.setattr(asyncio, "ProactorEventLoop", lambda: expected, raising=False)

    assert _loop_factory() is expected


def test_browser_loop_runs_work_on_its_own_thread():
    async def scenario():
        browser_loop = BrowserLoop()

        async def thread_id():
            return threading.get_ident()

        assert await browser_loop.run(thread_id()) != threading.get_ident()
        await browser_loop.close()
        assert not browser_loop.thread.is_alive()

    asyncio.run(scenario())


def test_cycle_persists_only_unknown_ids_from_the_entire_archive(tmp_path):
    async def scenario():
        watcher = TweetWatcher(data_dir=tmp_path, cycle=lambda _handle: None)
        watcher._write("sample", [{"id": "old"}] + [{"id": str(index)} for index in range(201)])
        captured = await watcher.record("sample", [{"id": "old"}, {"id": "reply-to-old"}])
        assert captured == 1
        assert "old" in watcher.recent_ids("sample")

    asyncio.run(scenario())


def test_pagination_stops_as_soon_as_it_reaches_a_known_id():
    assert should_stop_scrolling(reached_known=True, idle_windows=0) is True
    assert should_stop_scrolling(reached_known=False, idle_windows=0) is False


def test_a_failed_cycle_increases_backoff(tmp_path):
    async def scenario():
        async def broken(_handle):
            raise RuntimeError("challenge")

        watcher = TweetWatcher(data_dir=tmp_path, cycle=broken, jitter=lambda _a, _b: 0)
        await watcher.run_once("sample")
        assert watcher.current("sample").state == "failed"
        assert watcher.delay_seconds == 240

    asyncio.run(scenario())


def test_manual_refresh_uses_the_watchers_single_running_cycle(tmp_path):
    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()

        async def cycle(_handle):
            started.set()
            await release.wait()
            return []

        watcher = TweetWatcher(data_dir=tmp_path, cycle=cycle)
        first = watcher.refresh("sample")
        await started.wait()
        second = watcher.refresh("sample")
        assert second is first
        release.set()
        await watcher.task

    asyncio.run(scenario())


def test_a_failure_is_reported_as_its_own_cause(tmp_path):
    """The message has to send the reader at the thing that actually broke."""

    async def scenario():
        for error, expected in (
            (ModuleNotFoundError("No module named 'playwright'", name="playwright"), "playwright"),
            (RuntimeError("no hay sesión en el perfil"), "import_session.py"),
            (RuntimeError("Executable doesn't exist at chrome.exe"), "playwright install"),
            (NotImplementedError(), "--reload"),
        ):

            async def broken(_handle, error=error):
                raise error

            watcher = TweetWatcher(data_dir=tmp_path, cycle=broken, jitter=lambda _a, _b: 0)
            await watcher.run_once("sample")
            assert expected in watcher.current("sample").error

    asyncio.run(scenario())


def test_a_missing_dependency_stops_the_cadence_and_a_timeout_does_not(tmp_path):
    """
    Dying on a timeout is how the page ended up holding a watcher that had
    silently stopped watching; dying on a missing package is correct, because
    nothing the loop can do will install it.
    """

    async def scenario():
        for error, retries in (
            (ModuleNotFoundError("gone", name="gone"), False),
            # The loop the API runs on will not change while it runs, so coming
            # back on a timer only repeats the same failure.
            (NotImplementedError(), False),
            (TimeoutError(), True),
        ):

            async def broken(_handle, error=error):
                raise error

            watcher = TweetWatcher(data_dir=tmp_path, cycle=broken, jitter=lambda _a, _b: 0)
            await watcher.run_once("sample")
            assert watcher._retry_after_failure is retries

    asyncio.run(scenario())


def test_repeated_failures_widen_the_gap(tmp_path):
    async def scenario():
        async def broken(_handle):
            raise TimeoutError()

        watcher = TweetWatcher(data_dir=tmp_path, cycle=broken, jitter=lambda _a, _b: 0)
        seen = []
        for _ in range(5):
            await watcher.run_once("sample")
            seen.append(watcher.delay_seconds)
        assert seen == [240, 480, 960, 1800, 1800]

    asyncio.run(scenario())


def test_a_fatal_failure_ends_the_loop_without_the_two_tasks_awaiting_each_other(tmp_path):
    """
    `run_once` used to call `stop`, which cancels the very loop task that is
    awaiting `run_once`. The pair deadlocked, and cancelling the cycle recursed
    until the stack gave out — a `RecursionError` from inside uvloop naming no
    frame of this file. Reachable from the API's own startup, so the loop has
    to come apart on its own here.
    """

    async def scenario():
        async def broken(_handle):
            raise RuntimeError("no hay sesión en el perfil")

        watcher = TweetWatcher(data_dir=tmp_path, cycle=broken, jitter=lambda _a, _b: 0)
        watcher.watch("sample")
        await asyncio.wait_for(watcher._loop_task, timeout=5)
        assert watcher.current("sample").state == "failed"
        assert watcher._retry_after_failure is False

    asyncio.run(scenario())


def _tweet(tweet_id, date, text, reply_to=None):
    return {
        "rest_id": tweet_id,
        "legacy": {
            "created_at": date,
            "full_text": text,
            "in_reply_to_status_id_str": reply_to,
        },
        "core": {"user_results": {"result": {"core": {"screen_name": "sample"}}}},
    }


class _FakeMouse:
    async def wheel(self, _x, _y):
        return None


class _FakeReply:
    def __init__(self, url, payload):
        self.url = url
        self._payload = payload

    async def json(self):
        return self._payload


class _FakePage:
    """A page that answers each tab with the operation X serves it from."""

    def __init__(self, answers):
        self.answers = answers
        self.visited = []
        self.url = ""
        self.mouse = _FakeMouse()
        self.handlers = []

    def on(self, _event, handler):
        self.handlers.append(handler)

    def remove_listener(self, _event, handler):
        self.handlers.remove(handler)

    async def goto(self, url, **_kwargs):
        self.url = url
        self.visited.append(url)
        operation, payload = self.answers[url]
        for handler in list(self.handlers):
            await handler(_FakeReply(f"https://x.com/i/api/graphql/abc/{operation}", payload))


def test_is_timeline_url_knows_both_tabs_operations():
    assert is_timeline_url("https://x.com/i/api/graphql/a/UserRepliesTimeline")
    assert is_timeline_url("https://x.com/i/api/graphql/a/UserOriginalsTimeline")
    assert not is_timeline_url("https://x.com/i/api/graphql/a/UserByScreenName")


def test_a_capture_reads_the_posts_tab_as_well_as_the_replies_tab(tmp_path):
    """
    The replies tab leaves out posts the profile tab lists, so watching only
    `/with_replies` collected replies for hours while every original post the
    account wrote went unrecorded.
    """

    async def scenario():
        watcher = TweetWatcher(data_dir=tmp_path, jitter=lambda _a, _b: 0)
        watcher._write("sample", [{"id": "archived"}])
        archived = _tweet("archived", "Fri Aug 28 05:21:12 +0000 2026", "already held")
        page = _FakePage(
            {
                "https://x.com/sample": (
                    "UserOriginalsTimeline",
                    {
                        "data": [
                            _tweet("post", "Fri Aug 28 15:04:29 +0000 2026", "an original post"),
                            archived,
                        ]
                    },
                ),
                "https://x.com/sample/with_replies": (
                    "UserRepliesTimeline",
                    {
                        "data": [
                            _tweet("reply", "Fri Aug 28 18:03:10 +0000 2026", "@someone hi", "1"),
                            archived,
                        ]
                    },
                ),
            }
        )
        watcher._context = object()
        watcher._page = page
        captured = await watcher._capture_on_browser_loop("sample")

        assert page.visited == ["https://x.com/sample", "https://x.com/sample/with_replies"]
        assert {row["id"] for row in captured} == {"post", "reply", "archived"}
        assert page.handlers == []  # every listener the pass added is taken back off

    asyncio.run(scenario())
