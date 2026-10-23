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
from app.services.collector_cloud import CollectorCloud, CollectorRequest
from app.services.fare_budget import DailyBudget, PassLock, daily_budget
from app.services.fare_collector import (
    MAX_BOARD_IN_FLIGHT,
    REQUEST_GAP_SECONDS,
    CollectionReport,
    FareWatch,
    PassObserver,
    RouteResult,
    collect,
    expand,
)
from app.services.fare_passes import PassRecorder
from app.services.process_lock import (
    ProcessLockUnavailable,
    exclusive_process_lock,
)

LOGGER = logging.getLogger(__name__)
RECONCILE_SECONDS = 30.0
PROGRESS_SECONDS = 2.0
MANUAL_REQUEST_GAP_SECONDS = REQUEST_GAP_SECONDS
MANUAL_MAX_IN_FLIGHT = MAX_BOARD_IN_FLIGHT
MANUAL_MAX_ROUTES = 2
_IATA = re.compile(r"^[A-Z]{3}$")
_MONTH = re.compile(r"^[0-9]{4}-(0[1-9]|1[0-2])$")


class Recorder(Protocol):
    pass_id: str
    tally: Any

    def finish(
        self, *, exit_code: int, collection_ms: int | None = None, sync_ms: int | None = None
    ) -> None: ...


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


def _valid_pair(request: CollectorRequest) -> str | None:
    origin = request.payload.get("origin")
    destination = request.payload.get("destination")
    if (
        isinstance(origin, str)
        and isinstance(destination, str)
        and _IATA.fullmatch(origin)
        and _IATA.fullmatch(destination)
        and origin != destination
    ):
        return f"{origin}-{destination}"
    return None


async def _collect_route(
    watch: FareWatch,
    observer: PassObserver,
    pass_id: str,
    *,
    budget: DailyBudget | None = None,
    request_slots: asyncio.Semaphore | None = None,
    max_in_flight: int = MANUAL_MAX_IN_FLIGHT,
) -> CollectionReport:
    queries, unreadable = expand([watch])
    if unreadable:
        raise ValueError("invalid airfare request")
    # `collect_due` announces the plan for the scheduled pass; this path calls
    # `collect` directly, so it has to say how many departures it means to poll
    # itself — otherwise the row's bar has no denominator until the pass is over.
    observer.planned(polling=len(queries), skipped=[])
    options: dict[str, Any] = {"max_in_flight": max_in_flight}
    if budget is not None:
        options["budget"] = budget
    if request_slots is not None:
        options["request_slots"] = request_slots
    return await collect(
        list(queries.values()),
        observer=observer,
        pass_id=pass_id,
        gap_seconds=MANUAL_REQUEST_GAP_SECONDS,
        **options,
    )


def _sync_pass(origin: str, destination: str) -> bool:
    return AIRFARE_DATA.sync_manual_route(origin, destination).status == "complete"


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
        collect_route: Callable[..., Awaitable[CollectionReport]] = _collect_route,
        sync_pass: Callable[[CollectionReport], bool] | None = None,
        lock_factory: Callable[[str], AbstractContextManager[None]] = exclusive_process_lock,
        pass_lock_factory: Callable[[], PassLock] = PassLock,
        recorder_factory: Callable[..., Recorder] = PassRecorder,
        today: Callable[[], date] = lambda: datetime.now(UTC).date(),
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.cloud = cloud
        self.owner_id = cloud.owner_id
        self._collect_route = collect_route
        self._sync_pass = sync_pass
        self._lock_factory = lock_factory
        self._pass_lock_factory = pass_lock_factory
        self._recorder_factory = recorder_factory
        self._today = today
        self._clock = clock
        self._wake = asyncio.Event()
        self._run_stats = AirfareRunStats()
        self._route_locks: dict[tuple[str, str], asyncio.Lock] = {}

    @property
    def run_records(self) -> dict[str, int]:
        return self._run_stats.records()

    async def serve_request(
        self,
        request: CollectorRequest,
        *,
        pass_lock: PassLock | None = None,
        budget: DailyBudget | None = None,
        today: date | None = None,
        request_slots: asyncio.Semaphore | None = None,
        max_in_flight: int = MANUAL_MAX_IN_FLIGHT,
    ) -> bool:
        self._run_stats.seen += 1
        try:
            parsed = parse_airfare_request(
                request.payload, today=today if today is not None else self._today()
            )
        except (TypeError, ValueError):
            self._run_stats.failed += 1
            await self._fail(request.id, "invalid-request")
            return False

        recorder = self._recorder_factory(source="ui", kind="board", gap=MANUAL_REQUEST_GAP_SECONDS)
        progress = RequestProgress(self.cloud, request.id)
        report: CollectionReport | None = None
        collection_ms: int | None = None
        sync_ms: int | None = None
        try:
            collection_started = self._clock()
            try:
                options = (
                    {
                        "budget": budget
                        if budget is not None
                        else daily_budget(
                            lock=pass_lock,
                            gap=MANUAL_REQUEST_GAP_SECONDS,
                            pass_id=recorder.pass_id,
                        ),
                        "request_slots": request_slots,
                        "max_in_flight": max_in_flight,
                    }
                    if pass_lock is not None
                    else {}
                )
                report = await self._collect_route(
                    parsed.watch(), progress, recorder.pass_id, **options
                )
            finally:
                collection_ms = round((self._clock() - collection_started) * 1000)
            await progress.flush_collection(report)
        except Exception:
            LOGGER.exception("manual Airfare collection failed")
            self._run_stats.failed += 1
            await self._fail(request.id, "collection-failed")
            recorder.finish(exit_code=1, collection_ms=collection_ms)
            return False

        recorder.tally.boards(report)
        # A press that read nothing at all has nothing to sync and failed. One
        # that read some departures keeps them, like the scheduled pass always
        # has: failing the whole request over a few unreadable days used to skip
        # the sync and throw the rest of the month away. What was missed travels
        # in the result's `failed` and `skipped` counts instead.
        if len(report.results) - report.failed == 0:
            self._run_stats.failed += 1
            await self._fail(request.id, "collection-failed")
            recorder.finish(exit_code=1, collection_ms=collection_ms)
            return False

        try:
            await progress.syncing()
            sync_started = self._clock()
            try:
                synced = await (
                    asyncio.to_thread(self._sync_pass, report)
                    if self._sync_pass is not None
                    else asyncio.to_thread(_sync_pass, parsed.origin, parsed.destination)
                )
            finally:
                sync_ms = round((self._clock() - sync_started) * 1000)
        except Exception:  # noqa: BLE001 - no internal sync detail crosses the queue
            synced = False
        if not synced:
            self._run_stats.failed += 1
            await self._fail(request.id, "sync-failed")
            recorder.finish(exit_code=1, collection_ms=collection_ms, sync_ms=sync_ms)
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
            await asyncio.to_thread(self.cloud.complete_request, request.id, result)
        except Exception:  # noqa: BLE001 - completion may already have committed
            LOGGER.warning("manual Airfare worker could not confirm request completion")
            recorder.finish(exit_code=1, collection_ms=collection_ms, sync_ms=sync_ms)
            self._run_stats.failed += 1
            return False
        recorder.finish(exit_code=0, collection_ms=collection_ms, sync_ms=sync_ms)
        self._run_stats.written += 1
        return True

    async def reconcile_once(self, stop_event: asyncio.Event | None = None) -> bool:
        failures_before = self._run_stats.failed
        try:
            with self._lock_factory("airfare"):
                self._wake.clear()
                pass_lock = self._pass_lock_factory()
                if not pass_lock.acquire():
                    return True
                budgets: dict[date, DailyBudget] = {}

                def budget_for_day(day: date) -> DailyBudget:
                    if day not in budgets:
                        budgets[day] = daily_budget(
                            now=datetime(day.year, day.month, day.day, tzinfo=UTC),
                            lock=pass_lock,
                            gap=MANUAL_REQUEST_GAP_SECONDS,
                        )
                    return budgets[day]

                active: dict[asyncio.Task[bool], tuple[UUID, str | None]] = {}
                slots = asyncio.Semaphore(MANUAL_MAX_IN_FLIGHT)
                queue_empty = False
                draining = False
                try:
                    while True:
                        if stop_event is not None and stop_event.is_set():
                            draining = True
                        claimed: list[CollectorRequest] = []
                        while (
                            not draining
                            and not queue_empty
                            and len(active) + len(claimed) < MANUAL_MAX_ROUTES
                        ):
                            excluded = {pair for _, pair in active.values() if pair is not None}
                            excluded.update(
                                pair for item in claimed if (pair := _valid_pair(item)) is not None
                            )
                            claim_options = (
                                {"exclude_pairs": tuple(sorted(excluded))} if excluded else {}
                            )
                            request = await asyncio.to_thread(
                                self.cloud.claim_request, ("airfare-route",), **claim_options
                            )
                            if request is None:
                                queue_empty = True
                                break
                            claimed.append(request)
                            if stop_event is not None and stop_event.is_set():
                                draining = True
                        if not active and not claimed:
                            break
                        route_slots = MANUAL_MAX_IN_FLIGHT // (len(active) + len(claimed))
                        for request in claimed:
                            task = asyncio.create_task(
                                self._serve_claimed_request(
                                    request,
                                    pass_lock=pass_lock,
                                    budget_for_day=budget_for_day,
                                    request_slots=slots,
                                    max_in_flight=route_slots,
                                )
                            )
                            active[task] = (request.id, _valid_pair(request))
                        wake = (
                            asyncio.create_task(self._wake.wait())
                            if queue_empty and not draining
                            else None
                        )
                        stopped = (
                            asyncio.create_task(stop_event.wait())
                            if stop_event is not None and not draining
                            else None
                        )
                        try:
                            done, _ = await asyncio.wait(
                                set(active)
                                | ({wake} if wake is not None else set())
                                | ({stopped} if stopped is not None else set()),
                                timeout=RECONCILE_SECONDS if queue_empty and not draining else None,
                                return_when=asyncio.FIRST_COMPLETED,
                            )
                        finally:
                            for waiter in (wake, stopped):
                                if waiter is not None and not waiter.done():
                                    waiter.cancel()
                                    await asyncio.gather(waiter, return_exceptions=True)
                        if stopped is not None and stopped in done:
                            draining = True
                        if wake is not None and wake in done and not draining:
                            self._wake.clear()
                            queue_empty = False
                        elif not done and queue_empty and not draining:
                            queue_empty = False
                        for task in done:
                            if task is wake or task is stopped:
                                continue
                            request_id, _ = active.pop(task)
                            if not draining:
                                queue_empty = False
                            try:
                                task.result()
                            except Exception:
                                LOGGER.exception("manual Airfare request task failed")
                                self._run_stats.failed += 1
                                await self._fail(request_id, "worker-failed")
                finally:
                    for task in active:
                        task.cancel()
                    if active:
                        await asyncio.gather(*active, return_exceptions=True)
                    pass_lock.release()
        except ProcessLockUnavailable:
            return True
        return self._run_stats.failed == failures_before

    async def _serve_claimed_request(
        self,
        request: CollectorRequest,
        *,
        pass_lock: PassLock,
        budget_for_day: Callable[[date], DailyBudget],
        request_slots: asyncio.Semaphore,
        max_in_flight: int,
    ) -> bool:
        payload = request.payload
        pair = (str(payload.get("origin", "")), str(payload.get("destination", "")))
        route_lock = self._route_locks.setdefault(pair, asyncio.Lock())
        async with route_lock:
            today = self._today()
            return await self.serve_request(
                request,
                pass_lock=pass_lock,
                budget=budget_for_day(today),
                today=today,
                request_slots=request_slots,
                max_in_flight=max_in_flight,
            )

    def wake_requests(self) -> None:
        self._wake.set()

    async def run(
        self,
        stop_event: asyncio.Event,
        cycle_completed: Callable[[Mapping[str, int]], None] | None = None,
    ) -> None:
        while not stop_event.is_set():
            healthy = await self.reconcile_once(stop_event=stop_event)
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

    async def _fail(self, request_id: UUID, code: str) -> None:
        with contextlib.suppress(Exception):
            await asyncio.to_thread(self.cloud.fail_request, request_id, code)
