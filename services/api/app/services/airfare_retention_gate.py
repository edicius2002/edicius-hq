"""Persisted Airfare maintenance fence shared by local archive writers."""

from __future__ import annotations

import json
import os
import sys
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from datetime import date
from functools import wraps
from inspect import signature
from pathlib import Path
from typing import Any

if sys.platform == "win32":
    import msvcrt
else:
    import fcntl

_THREAD_LOCK = threading.RLock()
_LOCAL = threading.local()


@contextmanager
def maintenance_lock(fares: Path) -> Iterator[None]:
    """Serialize source writers and maintenance across threads and processes."""
    with _THREAD_LOCK:
        depth = getattr(_LOCAL, "depth", 0)
        if depth:
            _LOCAL.depth = depth + 1
            try:
                yield
            finally:
                _LOCAL.depth -= 1
            return
        path = fares / "retention" / "maintenance.lock"
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a+b") as handle:
            if handle.seek(0, os.SEEK_END) == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if sys.platform == "win32":
                while True:
                    try:
                        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                        break
                    except OSError:
                        time.sleep(0.05)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            _LOCAL.depth = 1
            try:
                yield
            finally:
                _LOCAL.depth = 0
                handle.seek(0)
                if sys.platform == "win32":
                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def guarded_fare_writer(
    fare_root: Callable[[Any], Path], departure_argument: str | None = None
) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
    """Hold the maintenance lock through the complete public write operation."""

    def decorate(method: Callable[..., Any]) -> Callable[..., Any]:
        parameters = signature(method)

        @wraps(method)
        def guarded(self: Any, *args: Any, **kwargs: Any) -> Any:
            fares = fare_root(self)
            bound = parameters.bind(self, *args, **kwargs)
            departure = bound.arguments.get(departure_argument) if departure_argument else None
            if departure is not None and hasattr(departure, "flight_date"):
                departure = departure.flight_date
            elif departure is not None and hasattr(departure, "start"):
                departure = departure.start
            with maintenance_lock(fares):
                check_fare_write(fares, departure=departure)
                return method(self, *args, **kwargs)

        return guarded

    return decorate


def check_fare_write(fares: Path, *, departure: str | None = None) -> None:
    """Fail closed on pending maintenance or a departure below its verified cutoff."""
    path = fares / "retention" / "state.json"
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return
    if not isinstance(body, dict) or body.get("phase") != "verified":
        raise ValueError("Airfare retention maintenance is pending")
    raw_cutoff = body.get("cutoff")
    if raw_cutoff is None or departure is None:
        return
    cutoff = date.fromisoformat(raw_cutoff)
    if date.fromisoformat(departure) < cutoff:
        raise ValueError("Airfare departure is below the retention cutoff")
