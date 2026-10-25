"""One pass acquisition independently of cloud availability."""

from __future__ import annotations

import logging
from collections.abc import Callable, Sequence
from datetime import UTC, datetime, timedelta
from functools import partial
from typing import Any

import httpx

from .models import HISTORY_START, REFERENCES, SOURCES, Observation
from .providers import ProviderError, fetch
from .store import Store

LOGGER = logging.getLogger(__name__)
# Cadence minus a margin wider than the timer's 30-second random delay, so a pass
# that starts with less delay than the last one still finds every source due.
_TIMER_MARGIN = timedelta(minutes=1)
_COMMERCIAL_EVERY = timedelta(minutes=5) - _TIMER_MARGIN
_REFERENCE_EVERY = timedelta(hours=4) - _TIMER_MARGIN


def collect_once(
    store: Store | None,
    cloud: Any,
    sources: Sequence[str] = SOURCES,
    *,
    now: datetime | None = None,
    dry_run: bool = False,
    fetcher: Callable[..., list[Observation]] | None = None,
) -> dict[str, int]:
    now = now or datetime.now(UTC)
    fetcher = fetcher or partial(fetch, response_cache={})
    if not sources or any(s not in SOURCES for s in sources):
        raise ValueError("invalid sources")
    if not dry_run and store is None:
        raise ValueError("durable store required")
    result = dict(seen=0, written=0, failed=0)
    failed_sources: set[str] = set()
    run = None
    if not dry_run and cloud is not None:
        try:
            run = cloud.begin_run("fx")
        except Exception:  # noqa: BLE001 - cloud failure must preserve local acquisition
            LOGGER.warning("FX cloud run unavailable")
    with httpx.Client() as client:
        for source in dict.fromkeys(sources):
            if not dry_run and store is not None and not store.due(source, now):
                continue
            previous = store.status(source) if store is not None else None
            try:
                rows = fetcher(source, client, now, None, None)
                result["seen"] += len(rows)
                rows = [row for row in rows if row.effective_at >= HISTORY_START]
                if not dry_run and store is not None:
                    store.save(
                        source,
                        rows,
                        now + (_REFERENCE_EVERY if source in REFERENCES else _COMMERCIAL_EVERY),
                        attempted_at=now,
                    )
            except ProviderError as error:
                result["failed"] += 1
                failed_sources.add(source)
                LOGGER.warning(
                    "FX source %s failed: %s status=%s bytes=%s stage=%s cause=%s",
                    source,
                    error.code,
                    error.status,
                    error.body_bytes,
                    error.stage,
                    error.cause,
                )
                if not dry_run and store is not None:
                    fast_retry = (
                        source == "kambista"
                        and error.code
                        in {"missing-quote", "invalid-html", "invalid-rate", "invalid-encoding"}
                        and previous is not None
                        and previous["consecutive_failures"] == 0
                    )
                    delay = int(_COMMERCIAL_EVERY.total_seconds()) if fast_retry else error.delay
                    store.save(
                        source,
                        [],
                        now + timedelta(seconds=delay),
                        attempted_at=now,
                        error_code=error.code,
                    )
    if not dry_run and store is not None:
        for source in dict.fromkeys(sources):
            if source in failed_sources:
                continue
            health = store.status(source)
            if health["last_attempt"] is None:
                continue  # Existing Pi databases warm up as each source becomes due.
            last_success = health["last_success"]
            max_age = timedelta(hours=5) if source in REFERENCES else timedelta(minutes=15)
            if last_success is None or now - last_success > max_age:
                result["failed"] += 1
                LOGGER.warning(
                    "FX source %s stale: last_success=%s next_due=%s error=%s",
                    source,
                    last_success,
                    health["next_due"],
                    health["last_error"],
                )
    if not dry_run and store is not None and cloud is not None:
        try:
            while pending := store.pending():
                before_start = [
                    row
                    for row in pending
                    if datetime.fromisoformat(row["effective_at"]) < HISTORY_START
                ]
                if before_start:
                    store.acknowledge(before_start)
                pending = [row for row in pending if row not in before_start]
                if not pending:
                    continue
                written = cloud.upsert_fx(pending)
                if written != len(pending):
                    raise RuntimeError("incomplete FX acknowledgement")
                store.acknowledge(pending)
                result["written"] += written
        except Exception:  # noqa: BLE001 - preserve outbox for replay
            result["failed"] += 1
            LOGGER.warning("FX outbox awaiting cloud replay")
        if run is not None:
            try:
                if result["failed"]:
                    cloud.heartbeat_run(run, result)
                    cloud.fail_run(run, "partial-failure")
                else:
                    cloud.finish_run(run, result)
            except Exception:  # noqa: BLE001 - cloud failure must preserve local acquisition
                LOGGER.warning("FX run acknowledgement unavailable")
    return result
