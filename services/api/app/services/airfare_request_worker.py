"""Raspberry Pi owner of forced, owner-scoped manual Airfare requests."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import re
import time
from collections.abc import Awaitable, Callable, Mapping
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from typing import Any, Protocol
from uuid import UUID

from app.services.airfare_data import AIRFARE_DATA
from app.services.collection_sync import sync_completed_pass
from app.services.collector_cloud import CollectorCloud, CollectorRequest
from app.services.fare_collector import (
    REQUEST_GAP_SECONDS,
    CollectionReport,
    FareWatch,
    PassObserver,
    RouteResult,
    collect,
    expand,
)
from app.services.fare_passes import WANTED_AND_REFUSED, PassRecorder
from app.services.process_lock import (
    ProcessLockUnavailable,
    exclusive_process_lock,
)

LOGGER = logging.getLogger(__name__)
RECONCILE_SECONDS = 30.0
PROGRESS_SECONDS = 2.0
_IATA = re.compile(r"^[A-Z]{3}$")
_MONTH = re.compile(r"^[0-9]{4}-(0[1-9]|1[0-2])$")


class Recorder(Protocol):
    pass_id: str
    tally: Any

    def finish(self, *, exit_code: int) -> None: ...


@dataclass(frozen=True, slots=True)
class AirfareRouteRequest:
    origin: str
    destination: str
    month: str
    currency: str

    def watch(self) -> FareWatch:
        return FareWatch(self.origin, self.destination, self.month, self.currency)


@dataclass
class AirfareRunStats:
    seen: int = 0
    written: int = 0
    failed: int = 0

    def records(self) -> dict[str, int]:
        return {"seen": self.seen, "written": self.written, "failed": self.failed}


def parse_airfare_request(payload: Mapping[str, Any], *, today: date) -> AirfareRouteRequest:
    if not isinstance(payload, Mapping) or set(payload) != {
        "origin",
        "destination",
        "month",
        "currency",
    }:
        raise ValueError("invalid airfare request")
    values = tuple(payload[key] for key in ("origin", "destination", "month", "currency"))
    if any(not isinstance(value, str) for value in values):
        raise ValueError("invalid airfare request")
    origin, destination, month, currency = values
    if (
        not _IATA.fullmatch(origin)
        or not _IATA.fullmatch(destination)
        or origin == destination
        or not _MONTH.fullmatch(month)
        or not _IATA.fullmatch(currency)
    ):
        raise ValueError("invalid airfare request")
    month_date = date(int(month[:4]), int(month[5:]), 1)
    first = today.replace(day=1)
    horizon = (today + timedelta(days=330)).replace(day=1)
    if month_date < first or month_date > horizon:
        raise ValueError("invalid airfare request")
    return AirfareRouteRequest(origin, destination, month, currency)


async def _collect_route(
    watch: FareWatch, observer: PassObserver, pass_id: str
) -> CollectionReport:
    queries, unreadable = expand([watch])
    if unreadable:
        raise ValueError("invalid airfare request")
    return await collect(list(queries.values()), observer=observer, pass_id=pass_id)


def _sync_pass(report: CollectionReport) -> bool:
    return sync_completed_pass(AIRFARE_DATA, report)


class RequestProgress(PassObserver):
    """Keep collector callbacks non-blocking while serializing cloud writes."""

    def __init__(
        self,
        cloud: CollectorCloud,
        request_id: UUID,
        *,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._cloud = cloud
        self._request_id = request_id
        self._clock = clock
        self._last_sent = float("-inf")
        self._completed = 0
        self._total: int | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self._write_lock = asyncio.Lock()

    def planned(self, *, polling: int, skipped: list[tuple[str, str]]) -> None:
        self._total = polling
        self._schedule(force=True)

    def collected(self, result: RouteResult, snapshot: object | None = None) -> None:
        del result, snapshot
        self._completed += 1
        self._schedule(force=False)

    def _value(self, stage: str = "collecting") -> dict[str, int | str | None]:
        return {"stage": stage, "completed": self._completed, "total": self._total}

    def _schedule(self, *, force: bool, stage: str = "collecting") -> None:
        now = self._clock()
        if not force and now - self._last_sent < PROGRESS_SECONDS:
            return
        self._last_sent = now
        task = asyncio.create_task(self._send(self._value(stage)))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _send(self, value: Mapping[str, Any]) -> None:
        async with self._write_lock:
            await asyncio.to_thread(self._cloud.update_request_progress, self._request_id, value)

    async def flush_collection(self, report: CollectionReport) -> None:
        self._completed = len(report.results)
        if self._total is None:
            self._total = len(report.results) + len(report.skipped)
        self._schedule(force=True)
        await self._drain()

    async def syncing(self) -> None:
        self._schedule(force=True, stage="syncing")
        await self._drain()

    async def _drain(self) -> None:
        while self._tasks:
            await asyncio.gather(*tuple(self._tasks))


class AirfareRequestWorker:
    """Consume only manual Airfare requests from the shared collector queue."""

    def __init__(
        self,
        cloud: CollectorCloud,
        *,
        collect_route: Callable[
            [FareWatch, PassObserver, str], Awaitable[CollectionReport]
        ] = _collect_route,
        sync_pass: Callable[[CollectionReport], bool] = _sync_pass,
        lock_factory: Callable[[str], AbstractContextManager[None]] = exclusive_process_lock,
        recorder_factory: Callable[..., Recorder] = PassRecorder,
        today: Callable[[], date] = lambda: datetime.now(UTC).date(),
    ) -> None:
        self.cloud = cloud
        self.owner_id = cloud.owner_id
        self._collect_route = collect_route
        self._sync_pass = sync_pass
        self._lock_factory = lock_factory
        self._recorder_factory = recorder_factory
        self._today = today
        self._wake = asyncio.Event()
        self._run_stats = AirfareRunStats()

    @property
    def run_records(self) -> dict[str, int]:
        return self._run_stats.records()

    async def serve_request(self, request: CollectorRequest) -> bool:
        self._run_stats.seen += 1
        try:
            parsed = parse_airfare_request(request.payload, today=self._today())
        except (TypeError, ValueError):
            self._run_stats.failed += 1
            self._fail(request.id, "invalid-request")
            return False

        recorder = self._recorder_factory(source="ui", kind="board", gap=REQUEST_GAP_SECONDS)
        progress = RequestProgress(self.cloud, request.id)
        report: CollectionReport | None = None
        try:
            report = await self._collect_route(parsed.watch(), progress, recorder.pass_id)
            await progress.flush_collection(report)
        except Exception:
            LOGGER.exception("manual Airfare collection failed")
            self._run_stats.failed += 1
            self._fail(request.id, "collection-failed")
            recorder.finish(exit_code=1)
            return False

        recorder.tally.boards(report)
        if report.failed or any(reason in WANTED_AND_REFUSED for _, reason in report.skipped):
            self._run_stats.failed += 1
            self._fail(request.id, "collection-failed")
            recorder.finish(exit_code=1)
            return False

        try:
            await progress.syncing()
            synced = await asyncio.to_thread(self._sync_pass, report)
        except Exception:  # noqa: BLE001 - no internal sync detail crosses the queue
            synced = False
        if not synced:
            self._run_stats.failed += 1
            self._fail(request.id, "sync-failed")
            recorder.finish(exit_code=1)
            return False

        result = {
            "origin": parsed.origin,
            "destination": parsed.destination,
            "month": parsed.month,
            "lookedAt": len(report.results),
            "changed": report.changed,
            "failed": report.failed,
            "skipped": len(report.skipped),
            "synced": True,
        }
        try:
            self.cloud.complete_request(request.id, result)
        except Exception:  # noqa: BLE001 - completion may already have committed
            LOGGER.warning("manual Airfare worker could not confirm request completion")
            recorder.finish(exit_code=1)
            self._run_stats.failed += 1
            return False
        recorder.finish(exit_code=0)
        self._run_stats.written += 1
        return True

    async def reconcile_once(self) -> bool:
        failures_before = self._run_stats.failed
        try:
            with self._lock_factory("airfare"):
                while (request := self.cloud.claim_request(("airfare-route",))) is not None:
                    await self.serve_request(request)
        except ProcessLockUnavailable:
            return True
        return self._run_stats.failed == failures_before

    def wake_requests(self) -> None:
        self._wake.set()

    async def run(
        self,
        stop_event: asyncio.Event,
        cycle_completed: Callable[[Mapping[str, int]], None] | None = None,
    ) -> None:
        while not stop_event.is_set():
            healthy = await self.reconcile_once()
            if healthy and cycle_completed is not None:
                cycle_completed(self.run_records)
            await self._wait_for_wake_or_stop(stop_event)

    async def _wait_for_wake_or_stop(self, stop_event: asyncio.Event) -> None:
        wake = asyncio.create_task(self._wake.wait())
        stopped = asyncio.create_task(stop_event.wait())
        try:
            done, _ = await asyncio.wait(
                {wake, stopped}, timeout=RECONCILE_SECONDS, return_when=asyncio.FIRST_COMPLETED
            )
            if wake in done:
                self._wake.clear()
        finally:
            for task in (wake, stopped):
                if not task.done():
                    task.cancel()
            await asyncio.gather(wake, stopped, return_exceptions=True)

    def _fail(self, request_id: UUID, code: str) -> None:
        with contextlib.suppress(Exception):
            self.cloud.fail_request(request_id, code)
