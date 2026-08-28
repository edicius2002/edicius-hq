"""One local owner of X's persistent browser profile.

The watcher deliberately owns both the two-minute cadence and the manual
refresh.  Starting a second scraper process would contend for Chromium's
profile lock and can quietly return no timeline entries.
"""

from __future__ import annotations

import asyncio
import json
import os
import random
import sys
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from app.config import tweets_dir
from app.services.pass_stream import PassBroadcast

DEFAULT_INTERVAL_SECONDS = int(os.getenv("X_TWEET_WATCH_INTERVAL_SECONDS", "120"))
RECENT_WINDOW = 200


@dataclass
class Refresh:
    handle: str
    state: str = "idle"
    scroll: int = 0
    new: int = 0
    error: str | None = None
    finishedAt: str | None = None


Cycle = Callable[[str], Awaitable[list[dict[str, Any]] | None]]


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
        self._context: Any | None = None
        self._playwright: Any | None = None
        self._page: Any | None = None
        self.stream: PassBroadcast[dict[str, Any]] = PassBroadcast()

    def current(self, handle: str | None = None) -> Refresh | None:
        if handle is None or self.pass_ is None or self.pass_.handle == handle:
            return self.pass_
        return None

    def recent_ids(self, handle: str) -> set[str]:
        path = self.data_dir / f"{handle}.jsonl"
        if not path.exists():
            return set()
        ids: list[str] = []
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                value = json.loads(line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict) and value.get("id"):
                ids.append(str(value["id"]))
        return set(ids[-RECENT_WINDOW:])

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
                # A dead session/challenge is not a transient scheduling miss:
                # do not reopen the profile every two minutes until it is fixed.
                if self.pass_ and self.pass_.state == "failed":
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
            # session can raise has to stop the cadence rather than escape into a
            # loop that would then retry it every two minutes.
            self.pass_.state = "failed"
            self.pass_.error = (
                f"Sesión X inválida o challenge; ejecuta import_session.py. ({error})"
            )
            self.pass_.finishedAt = datetime.now(UTC).isoformat()
            self.delay_seconds = min(max(self.interval_seconds * 2, 240), 1800)
            await self.stop(close_browser=True, mark_stopped=False)
        finally:
            self.stream.publish()

    async def stop(self, *, close_browser: bool = True, mark_stopped: bool = True) -> None:
        if self._loop_task and self._loop_task is not asyncio.current_task():
            self._loop_task.cancel()
            with __import__("contextlib").suppress(asyncio.CancelledError):
                await self._loop_task
        self._loop_task = None
        if self.pass_ and mark_stopped:
            self.pass_.state = "stopped"
        if close_browser:
            await self._close_browser()
        self.stream.publish()

    async def _close_browser(self) -> None:
        if self._context is not None:
            await self._context.close()
        self._context = self._page = None
        if self._playwright is not None:
            await self._playwright.stop()
        self._playwright = None

    async def _capture(self, handle: str) -> list[dict[str, Any]]:
        """Navigate once and wait only for the first timeline payload."""
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

        received: asyncio.Future[list[dict[str, Any]]] = asyncio.get_running_loop().create_future()

        async def response(reply: Any) -> None:
            if "UserRepliesTimeline" not in reply.url or received.done():
                return
            try:
                received.set_result(extract_tweets(await reply.json(), handle))
            except Exception as error:  # noqa: BLE001 - a body X answered 200 with is
                # not necessarily JSON, and whatever it is must reach the awaiting
                # caller rather than escape inside Playwright's own event handler.
                received.set_exception(error)

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
        return await asyncio.wait_for(received, timeout=20)


RUNNER = TweetWatcher()
