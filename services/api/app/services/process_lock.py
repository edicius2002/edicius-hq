"""Cross-platform nonblocking process locks for collector entrypoints."""

from __future__ import annotations

import os
from collections.abc import Iterator
from contextlib import contextmanager
from typing import TextIO

from app.config import local_data_dir


class ProcessLockUnavailable(RuntimeError):
    """Raised when another process owns the collector entrypoint lock."""


def _lock(handle: TextIO) -> None:
    if os.name == "nt":
        import msvcrt

        locking = msvcrt.locking  # type: ignore[attr-defined]
        nonblocking = msvcrt.LK_NBLCK  # type: ignore[attr-defined]
        try:
            handle.seek(0)
            if handle.read(1) == "":
                handle.write("0")
                handle.flush()
            handle.seek(0)
            locking(handle.fileno(), nonblocking, 1)
        except OSError as error:
            raise ProcessLockUnavailable from error
        return

    import fcntl

    try:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError as error:
        raise ProcessLockUnavailable from error


def _unlock(handle: TextIO) -> None:
    if os.name == "nt":
        import msvcrt

        locking = msvcrt.locking  # type: ignore[attr-defined]
        unlock = msvcrt.LK_UNLCK  # type: ignore[attr-defined]
        handle.seek(0)
        locking(handle.fileno(), unlock, 1)
        return

    import fcntl

    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


@contextmanager
def exclusive_process_lock(name: str) -> Iterator[None]:
    """Hold one named collector lock or fail immediately without doing work."""
    if not name or any(character not in "abcdefghijklmnopqrstuvwxyz-" for character in name):
        raise ValueError("invalid process lock name")
    lock_dir = local_data_dir() / "locks"
    lock_dir.mkdir(parents=True, exist_ok=True)
    lock_path = lock_dir / f"{name}.lock"
    with lock_path.open("a+", encoding="ascii") as handle:
        _lock(handle)
        try:
            yield
        finally:
            _unlock(handle)
