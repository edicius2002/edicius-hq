"""One pass acquisition independently of cloud availability."""

from __future__ import annotations

import logging
from collections.abc import Callable, Iterator, Sequence
from datetime import UTC, date, datetime, timedelta
from functools import partial
from typing import Any

import httpx

from .models import REFERENCES, SOURCES, Observation
from .providers import ProviderError, fetch
from .store import Store

LOGGER = logging.getLogger(__name__)
# Cadence minus a margin wider than the timer's 30-second random delay, so a pass
# that starts with less delay than the last one still finds every source due.
_TIMER_MARGIN = timedelta(minutes=1)
_COMMERCIAL_EVERY = timedelta(minutes=15) - _TIMER_MARGIN
_REFERENCE_EVERY = timedelta(hours=4) - _TIMER_MARGIN


def year_ranges(start: date, end: date) -> Iterator[tuple[date, date]]:
    if start < date(1997, 1, 1) or start > end or end > datetime.now(UTC).date():
        raise ValueError("backfill must be between 1997 and today")
    while start <= end:
        stop = min(end, date(start.year, 12, 31))
        yield start, stop
        start = stop + timedelta(days=1)


def collect_once(
    store: Store | None,
    cloud: Any,
    sources: Sequence[str] = SOURCES,
    *,
    now: datetime | None = None,
    dry_run: bool = False,
    fetcher: Callable[..., list[Observation]] | None = None,
    backfill: tuple[date, date] | None = None,
) -> dict[str, int]:
    now = now or datetime.now(UTC)
    fetcher = fetcher or partial(fetch, response_cache={})
    if not sources or any(s not in SOURCES for s in sources):
        raise ValueError("invalid sources")
    if backfill and any(s not in REFERENCES for s in sources):
        raise ValueError("backfill supports bcrp and sbs only")
    if not dry_run and store is None:
        raise ValueError("durable store required")
    windows = list(year_ranges(*backfill)) if backfill else [(None, None)]
    result = dict(seen=0, written=0, failed=0)
    run = None
    if not dry_run and cloud is not None:
        try:
            run = cloud.begin_run("fx")
        except Exception:  # noqa: BLE001 - cloud failure must preserve local acquisition
            LOGGER.warning("FX cloud run unavailable")
    with httpx.Client() as client:
        for source in dict.fromkeys(sources):
            if (
                not dry_run
                and store is not None
                and not store.due(source, now, backfill=backfill is not None)
            ):
                continue
            for start, end in windows:
                window = f"{start}/{end}" if backfill else None
                if window and store and store.completed(source, window):
                    continue
                try:
                    rows = fetcher(source, client, now, start, end)
                    result["seen"] += len(rows)
                    if not dry_run and store is not None:
                        store.save(
                            source,
                            rows,
                            now + (_REFERENCE_EVERY if source in REFERENCES else _COMMERCIAL_EVERY),
                            window,
                        )
                except ProviderError as error:
                    result["failed"] += 1
                    LOGGER.warning("FX source %s failed: %s", source, error)
                    if not dry_run and store is not None:
                        store.save(source, [], now + timedelta(seconds=error.delay), failed=True)
                    break
    if not dry_run and store is not None and cloud is not None:
        try:
            while pending := store.pending():
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
