"""One local owner of X's persistent browser profile.

The watcher deliberately owns both the two-minute cadence and the manual
refresh.  Starting a second scraper process would contend for Chromium's
profile lock and can quietly return no timeline entries.
"""

from __future__ import annotations

import asyncio
import contextlib
import json
import os
import random
import sys
import threading
from collections.abc import Awaitable, Callable, Coroutine
from concurrent.futures import Future
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import tweets_dir
from app.services.pass_stream import PassBroadcast

DEFAULT_INTERVAL_SECONDS = int(os.getenv("X_TWEET_WATCH_INTERVAL_SECONDS", "120"))
MAX_SCROLLS = 80
SCROLL_PATIENCE = 4

# The two the capture raises itself, in `_capture`. Matched on the text because
# they arrive as plain RuntimeError, and inventing an exception class for a
# string two lines away would be ceremony rather than clarity.
SESSION_MARKERS = ("no hay sesión en el perfil", "la sesión expiró")


def should_stop_scrolling(*, reached_known: bool, idle_windows: int) -> bool:
    """Keep the incremental pass bounded after it has reached its archive."""
    return reached_known or idle_windows >= SCROLL_PATIENCE


@dataclass(frozen=True)
class Failure:
    """Why a pass failed, and whether waiting is a plausible cure.

    Every failure used to be reported as a dead X session, which sent the
    reader to `import_session.py` for a missing Python package, a browser that
    was never downloaded, and a timeout alike — three problems that share no
    fix with the one the message named.
    """

    message: str
    transient: bool


def diagnose(error: BaseException) -> Failure:
    text = str(error)
    if isinstance(error, ImportError):
        missing = getattr(error, "name", None) or text
        return Failure(
            f"Falta la dependencia '{missing}' en el entorno de la API; instala "
            f"services/api/requirements.txt con el intérprete que corre uvicorn. ({text})",
            transient=False,
        )
    # Nothing about a bare `NotImplementedError` points at the reloader, and the
    # traceback names only asyncio's own internals, so the cause is spelled out
    # here: on Windows uvicorn switches to a selector event loop whenever it
    # runs a subprocess of its own, and that loop cannot spawn one — which is
    # the first thing Playwright's driver asks for. Fatal rather than transient:
    # the loop the API is running on will not change while it runs.
    if isinstance(error, NotImplementedError):
        return Failure(
            "El event loop no puede lanzar subprocesos, así que Playwright no "
            "arranca su driver. En Windows lo causa uvicorn con --reload: usa "
            "`npm start`, o levanta la API sin el reloader.",
            transient=False,
        )
    if "playwright install" in text or "Executable doesn't exist" in text:
        return Failure(
            "Playwright está instalado pero le falta el navegador; ejecuta "
            f"`python -m playwright install chromium`. ({text})",
            transient=False,
        )
    if any(marker in text for marker in SESSION_MARKERS):
        return Failure(
            f"Sesión X inválida o challenge; ejecuta import_session.py. ({text})",
            transient=False,
        )
    # Playwright raises its own `TimeoutError`, which does not inherit the
    # builtin, so the name is checked as well as the type.
    if isinstance(error, TimeoutError) or type(error).__name__ == "TimeoutError":
        return Failure(
            f"X no devolvió la timeline a tiempo. ({text or type(error).__name__})",
            transient=True,
        )
    return Failure(f"La captura falló: {text or type(error).__name__}", transient=True)


@dataclass
class Refresh:
    handle: str
    state: str = "idle"
    scroll: int = 0
    new: int = 0
    error: str | None = None
    finishedAt: str | None = None


Cycle = Callable[[str], Awaitable[list[dict[str, Any]] | None]]


def _loop_factory() -> asyncio.AbstractEventLoop:
    """Create a loop that can launch Playwright's driver on this platform."""
    if sys.platform == "win32":
        return asyncio.ProactorEventLoop()  # type: ignore[attr-defined]
    return asyncio.new_event_loop()


class BrowserLoop:
    """Keep browser-bound asyncio objects on one loop in one dedicated thread."""

    def __init__(self) -> None:
        self.loop = _loop_factory()
        self._ready = threading.Event()
        # Daemon so a browser that will not come apart cannot hold the process
        # open: `lifespan` stops this loop on the ordinary path, and the only
        # time the flag decides anything is when that has already gone wrong.
        # An API that will not exit is answered with a forced kill, and a
        # forced kill is what takes Chromium down mid-write and empties the
        # profile — the session then has to be seeded again.
        self.thread = threading.Thread(target=self._run, name="tweet-watcher-browser", daemon=True)
        self.thread.start()
        self._ready.wait()

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self._ready.set()
        self.loop.run_forever()
        pending = asyncio.all_tasks(self.loop)
        for task in pending:
            task.cancel()
        if pending:
            self.loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        self.loop.close()

    async def run(self, coroutine: Coroutine[Any, Any, Any]) -> Any:
        """Await browser-loop work from the API loop without sharing its objects."""
        future: Future[Any] = asyncio.run_coroutine_threadsafe(coroutine, self.loop)
        return await asyncio.wrap_future(future)

    async def close(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        await asyncio.to_thread(self.thread.join)


class TweetWatcher:
    def __init__(
        self,
        *,
        data_dir: Path | None = None,
        cycle: Cycle | None = None,
        interval_seconds: int = DEFAULT_INTERVAL_SECONDS,
        jitter: Callable[[float, float], float] = random.uniform,
    ) -> None:
        self.data_dir = data_dir or tweets_dir()
        self._cycle = cycle or self._capture
        self.interval_seconds = interval_seconds
        self.jitter = jitter
        self.delay_seconds = interval_seconds
        self.pass_: Refresh | None = None
        self.task: asyncio.Task[None] | None = None
        self._loop_task: asyncio.Task[None] | None = None
        self._wake = asyncio.Event()
        self._retry_after_failure = False
        self._context: Any | None = None
        self._playwright: Any | None = None
        self._page: Any | None = None
        self._browser_loop: BrowserLoop | None = None
        self.stream: PassBroadcast[dict[str, Any]] = PassBroadcast()

    def current(self, handle: str | None = None) -> Refresh | None:
        if handle is None or self.pass_ is None or self.pass_.handle == handle:
            return self.pass_
        return None

    def recent_ids(self, handle: str) -> set[str]:
        path = self.data_dir / f"{handle}.jsonl"
        if not path.exists():
            return set()
        ids: set[str] = set()
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("id"):
                ids.add(str(value["id"]))
        # JSONL is small enough to read as a whole, and an old ID is still an
        # ID we must never write again. A bounded tail silently duplicates a
        # burst once it has been pushed past the window.
        return ids

    def _write(self, handle: str, rows: list[dict[str, Any]]) -> None:
        if not rows:
            return
        path = self.data_dir / f"{handle}.jsonl"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as stream:
            for row in rows:
                stream.write(json.dumps(row, ensure_ascii=False) + "\n")

    async def record(self, handle: str, rows: list[dict[str, Any]]) -> int:
        known = self.recent_ids(handle)
        fresh = [row for row in rows if str(row.get("id", "")) and str(row["id"]) not in known]
        self._write(handle, fresh)
        for row in fresh:
            self.stream.write(row)
        return len(fresh)

    def watch(self, handle: str) -> Refresh:
        # Bound to a local so what is returned is the pass this call guaranteed,
        # rather than a field that is only set down one of the two branches.
        current = self.pass_
        if self._loop_task is None or self._loop_task.done() or current is None:
            current = self.pass_ = Refresh(handle=handle, state="watching")
            self._loop_task = asyncio.create_task(self._watch(handle))
        return current

    def refresh(self, handle: str) -> Refresh:
        self.watch(handle)
        self._wake.set()
        if self.task is None or self.task.done():
            self.task = asyncio.create_task(self.run_once(handle))
        return self.pass_  # type: ignore[return-value]

    start = refresh

    async def _watch(self, handle: str) -> None:
        try:
            while True:
                if self.task is None or self.task.done():
                    self.task = asyncio.create_task(self.run_once(handle))
                await self.task
                # A dead session, a missing dependency or a browser that was
                # never downloaded is not a transient scheduling miss: do not
                # reopen the profile until someone has fixed it. A timeout is,
                # and dying on one left the page with a watcher that had
                # silently stopped watching.
                if self.pass_ and self.pass_.state == "failed" and not self._retry_after_failure:
                    return
                try:
                    await asyncio.wait_for(
                        self._wake.wait(), self.delay_seconds + self.jitter(0, 15)
                    )
                    self._wake.clear()
                except TimeoutError:
                    pass
                if self.pass_ and self.pass_.state == "stopped":
                    return
        except asyncio.CancelledError:
            raise

    async def run_once(self, handle: str) -> None:
        if self.pass_ is None or self.pass_.handle != handle:
            self.pass_ = Refresh(handle=handle)
        self.pass_.state = "running"
        self.pass_.new = 0
        self.pass_.scroll = 0
        self.pass_.error = None
        self.pass_.finishedAt = None
        self.stream.publish()
        try:
            rows = await self._cycle(handle) or []
            self.pass_.new = await self.record(handle, rows)
            self.pass_.state = "finished"
            self.pass_.finishedAt = datetime.now(UTC).isoformat()
            self.delay_seconds = self.interval_seconds
        except Exception as error:  # noqa: BLE001 - anything the browser or the
            # session can raise has to be named for the reader rather than escape
            # into a loop that would then retry it every two minutes.
            failure = diagnose(error)
            self.pass_.state = "failed"
            self.pass_.error = failure.message
            self.pass_.finishedAt = datetime.now(UTC).isoformat()
            # Doubling rather than a constant: a transient fault now comes back,
            # so what bounds the retries is the gap growing, not the loop dying.
            self.delay_seconds = min(max(self.delay_seconds * 2, 240), 1800)
            self._retry_after_failure = failure.transient
            # The browser is closed here; the loop never is. `stop` cancels
            # `_loop_task`, and `_loop_task` is precisely what is awaiting this
            # call — the two ended up awaiting each other, and cancelling that
            # cycle recursed until the stack gave out, surfacing as a
            # `RecursionError` inside uvloop's callback with no frame of this
            # file in it to say where it came from. Ending the loop is the
            # loop's own business, and `_retry_after_failure` is what it reads
            # to decide. Whatever the next pass needs, it is not the context
            # that just failed, so that much goes either way.
            await self._close_browser()
        finally:
            self.stream.publish()

    async def stop(self, *, close_browser: bool = True, mark_stopped: bool = True) -> None:
        if self._loop_task and self._loop_task is not asyncio.current_task():
            self._loop_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._loop_task
        self._loop_task = None
        if self.pass_ and mark_stopped:
            self.pass_.state = "stopped"
        if close_browser:
            await self._close_browser()
        self.stream.publish()

    async def _close_browser(self) -> None:
        browser_loop = self._browser_loop
        if browser_loop is None:
            return
        try:
            await browser_loop.run(self._close_browser_on_browser_loop())
        finally:
            self._browser_loop = None
            await browser_loop.close()

    async def _close_browser_on_browser_loop(self) -> None:
        if self._context is not None:
            await self._context.close()
        self._context = self._page = None
        if self._playwright is not None:
            await self._playwright.stop()
        self._playwright = None

    async def _capture(self, handle: str) -> list[dict[str, Any]]:
        """Run browser-bound work on its persistent subprocess-capable loop."""
        if self._browser_loop is None:
            self._browser_loop = BrowserLoop()
        return await self._browser_loop.run(self._capture_on_browser_loop(handle))

    async def _capture_on_browser_loop(self, handle: str) -> list[dict[str, Any]]:
        """Capture pages until the timeline reaches an archived tweet."""
        tools = Path(__file__).resolve().parents[4] / "tools" / "x-scraper"
        if str(tools) not in sys.path:
            sys.path.insert(0, str(tools))
        from playwright.async_api import async_playwright
        from x_scraper import extract_tweets

        if self._context is None:
            self._playwright = await async_playwright().start()
            profile = Path(
                os.getenv("X_SCRAPER_PROFILE", "~/.local/share/x-scraper/profile")
            ).expanduser()
            self._context = await self._playwright.chromium.launch_persistent_context(
                str(profile),
                headless=True,
                viewport={"width": 1365, "height": 900},
                args=["--disable-blink-features=AutomationControlled"],
            )
            if not any(cookie["name"] == "auth_token" for cookie in await self._context.cookies()):
                raise RuntimeError("no hay sesión en el perfil")
            self._page = (
                self._context.pages[0] if self._context.pages else await self._context.new_page()
            )

        known = self.recent_ids(handle)
        tweets: list[dict[str, Any]] = []
        seen: set[str] = set()
        received = asyncio.Event()
        reached_known = asyncio.Event()
        # Playwright calls the handler below from its own task, so an exception
        # raised there reaches nobody: it is collected and re-raised on the side
        # that is actually awaiting, which is what `set_exception` on a future
        # did before this became an event.
        failure: list[BaseException] = []

        async def response(reply: Any) -> None:
            if "UserRepliesTimeline" not in reply.url:
                return
            try:
                for tweet in extract_tweets(await reply.json(), handle):
                    tweet_id = str(tweet["id"])
                    if tweet_id in seen:
                        continue
                    seen.add(tweet_id)
                    tweets.append(tweet)
                    if tweet_id in known:
                        reached_known.set()
            except Exception as error:  # noqa: BLE001 - a body X answered 200 with is
                # not necessarily JSON, and whatever it is has to reach the
                # awaiting caller rather than escape inside Playwright's own
                # event handler, where nothing would ever look at it.
                failure.append(error)
            finally:
                # Released either way: a batch that failed to parse is news, and
                # leaving it to time out after twenty seconds reports a timeout
                # for what is a parse error.
                received.set()

        # The page is only opened alongside a fresh context, so a context that
        # survived a failure without one is a state worth naming rather than an
        # attribute error three lines down.
        page = self._page
        if page is None:
            raise RuntimeError("el navegador no tiene página")

        page.on("response", response)
        await page.goto(
            f"https://x.com/{handle}/with_replies", wait_until="domcontentloaded", timeout=60_000
        )
        if "/i/flow/login" in page.url:
            raise RuntimeError("la sesión expiró")
        await asyncio.wait_for(received.wait(), timeout=20)
        if failure:
            raise failure[0]
        idle_windows = 0
        for scroll_number in range(1, MAX_SCROLLS + 1):
            if should_stop_scrolling(
                reached_known=reached_known.is_set(), idle_windows=idle_windows
            ):
                break
            before_seen = len(seen)
            received.clear()
            await page.mouse.wheel(0, random.randint(700, 1_300))
            if self.pass_ is not None:
                self.pass_.scroll = scroll_number
                self.stream.publish()
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(received.wait(), timeout=4)
            if failure:
                raise failure[0]
            idle_windows = 0 if len(seen) > before_seen else idle_windows + 1
            if should_stop_scrolling(
                reached_known=reached_known.is_set(), idle_windows=idle_windows
            ):
                break
        return tweets


RUNNER = TweetWatcher()
