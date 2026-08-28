"""Local-only subprocess runner for one X incremental refresh."""
import asyncio
import os
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

TIMEOUT_SECONDS = 300

@dataclass
class Refresh:
    handle: str
    state: str = "idle"
    scroll: int = 0
    new: int = 0
    error: str | None = None
    finishedAt: str | None = None

class TweetRefreshRunner:
    def __init__(self) -> None:
        self.pass_: Refresh | None = None
        self.task: asyncio.Task[None] | None = None

    def current(self) -> Refresh | None:
        return self.pass_

    def start(self, handle: str) -> Refresh:
        if self.pass_ and self.pass_.state == "running":
            return self.pass_
        self.pass_ = Refresh(handle=handle, state="running")
        self.task = asyncio.create_task(self._guarded_run())
        return self.pass_

    async def _guarded_run(self) -> None:
        try:
            await asyncio.wait_for(self._run(), timeout=TIMEOUT_SECONDS)
        except TimeoutError:
            self._fail("La recaptura excedió cinco minutos y fue detenida.")
        except Exception as error:
            self._fail(f"No se pudo ejecutar el scraper local: {error}")

    def _fail(self, message: str) -> None:
        assert self.pass_
        self.pass_.state = "failed"
        self.pass_.error = message
        self.pass_.finishedAt = datetime.now(UTC).isoformat()

    async def _run(self) -> None:
        assert self.pass_
        root = Path(os.getenv("REPO_ROOT", Path(__file__).resolve().parents[4]))
        script = root / "tools" / "x-scraper" / "scrape.py"
        python = os.getenv("X_SCRAPER_PYTHON", sys.executable)
        if not script.is_file():
            self._fail("No se encontró tools/x-scraper/scrape.py; configura REPO_ROOT.")
            return
        env = {**os.environ, "PLAYWRIGHT_HOST_PLATFORM_OVERRIDE": os.getenv("PLAYWRIGHT_HOST_PLATFORM_OVERRIDE", "ubuntu24.04-x64")}
        proc = await asyncio.create_subprocess_exec(python, str(script), self.pass_.handle, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.STDOUT, env=env)
        assert proc.stdout
        async for raw in proc.stdout:
            match = re.search(r"scroll (\d+).*nuevos (\d+)", raw.decode(errors="replace"))
            if match:
                self.pass_.scroll, self.pass_.new = map(int, match.groups())
        if await proc.wait() == 0:
            self.pass_.state = "finished"
            self.pass_.finishedAt = datetime.now(UTC).isoformat()
        elif not self.pass_.error:
            self._fail("Sesión X inválida; ejecuta import_session.py.")

RUNNER = TweetRefreshRunner()
