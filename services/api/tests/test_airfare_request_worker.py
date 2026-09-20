"""Manual Airfare requests stay queued until the Pi can own the Airfare lock."""

from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from unittest.mock import AsyncMock, Mock, call
from uuid import UUID

from app.services.airfare_request_worker import AirfareRequestWorker
from app.services.collector_cloud import CollectorRequest
from app.services.fare_collector import CollectionReport, RouteResult
from app.services.process_lock import ProcessLockUnavailable

OWNER = UUID("11111111-1111-1111-1111-111111111111")
REQUEST_ID = UUID("22222222-2222-2222-2222-222222222222")


def request(payload: object | None = None) -> CollectorRequest:
    return CollectorRequest(
        REQUEST_ID,
        OWNER,
        "airfare-route",
        payload or {"origin": "LIM", "destination": "CUZ", "month": "2026-11", "currency": "USD"},
        datetime.now(UTC) + timedelta(minutes=30),
    )


def report(*, failed: bool = False, skipped: list[tuple[str, str]] | None = None):
    results = [
        RouteResult("LIM", "CUZ", "2026-11-01", None, True, changed=True),
        RouteResult("LIM", "CUZ", "2026-11-02", None, True, changed=True),
        RouteResult(
            "LIM",
            "CUZ",
            "2026-11-03",
            None,
            not failed,
            error_code="upstream-error" if failed else None,
        ),
    ]
    return CollectionReport("start", "finish", "google", results, skipped or [])


@contextmanager
def available_lock(_name: str):
    yield


def worker_for(remote: Mock, **kwargs) -> AirfareRequestWorker:
    recorder = Mock(pass_id="test-pass")
    return AirfareRequestWorker(
        remote,
        lock_factory=available_lock,
        today=lambda: date(2026, 9, 19),
        recorder_factory=Mock(return_value=recorder),
        **kwargs,
    )


def test_success_completes_only_after_progress_and_sync():
    remote = Mock(owner_id=OWNER)
    remote.claim_request.side_effect = [request(), None]
    order: list[str] = []

    async def collect_route(_watch, observer, _pass_id):
        observer.planned(polling=3, skipped=[])
        for result in report().results:
            observer.collected(result)
        order.append("collected")
        return report()

    def sync_pass(_report):
        order.append("synced")
        return True

    remote.complete_request.side_effect = lambda *_: order.append("complete")
    worker = worker_for(remote, collect_route=collect_route, sync_pass=sync_pass)

    assert asyncio.run(worker.reconcile_once()) is True

    assert order == ["collected", "synced", "complete"]
    remote.claim_request.assert_has_calls([call(("airfare-route",)), call(("airfare-route",))])
    remote.complete_request.assert_called_once_with(
        REQUEST_ID,
        {
            "origin": "LIM",
            "destination": "CUZ",
            "month": "2026-11",
            "lookedAt": 3,
            "changed": 2,
            "failed": 0,
            "skipped": 0,
            "synced": True,
        },
    )
    stages = [entry.args[1]["stage"] for entry in remote.update_request_progress.call_args_list]
    assert stages[0] == "collecting"
    assert stages[-1] == "syncing"


def test_invalid_payload_fails_without_collecting():
    remote = Mock(owner_id=OWNER)
    remote.claim_request.side_effect = [request({"origin": "LI"}), None]
    collect_route = AsyncMock()

    assert asyncio.run(worker_for(remote, collect_route=collect_route).reconcile_once()) is False

    collect_route.assert_not_called()
    remote.fail_request.assert_called_once_with(REQUEST_ID, "invalid-request")


def test_departed_or_beyond_horizon_month_is_invalid():
    for month in ("2026-08", "2027-09"):
        remote = Mock(owner_id=OWNER)
        remote.claim_request.side_effect = [
            request({"origin": "LIM", "destination": "CUZ", "month": month, "currency": "USD"}),
            None,
        ]

        assert asyncio.run(worker_for(remote).reconcile_once()) is False
        remote.fail_request.assert_called_once_with(REQUEST_ID, "invalid-request")


def test_failed_or_truncated_collection_never_syncs_or_completes():
    for collected in (
        report(failed=True),
        report(skipped=[("LIM-CUZ 2026-11-04", "over-budget")]),
    ):
        remote = Mock(owner_id=OWNER)
        remote.claim_request.side_effect = [request(), None]
        sync_pass = Mock(return_value=True)

        healthy = asyncio.run(
            worker_for(
                remote,
                collect_route=AsyncMock(return_value=collected),
                sync_pass=sync_pass,
            ).reconcile_once()
        )

        assert healthy is False
        sync_pass.assert_not_called()
        remote.complete_request.assert_not_called()
        remote.fail_request.assert_called_once_with(REQUEST_ID, "collection-failed")


def test_sync_false_or_exception_is_a_sanitized_failure():
    for outcome in (False, RuntimeError("private remote detail")):
        remote = Mock(owner_id=OWNER)
        remote.claim_request.side_effect = [request(), None]
        sync_pass = Mock(side_effect=outcome if isinstance(outcome, Exception) else None)
        if outcome is False:
            sync_pass.return_value = False

        healthy = asyncio.run(
            worker_for(
                remote,
                collect_route=AsyncMock(return_value=report()),
                sync_pass=sync_pass,
            ).reconcile_once()
        )

        assert healthy is False
        remote.complete_request.assert_not_called()
        remote.fail_request.assert_called_once_with(REQUEST_ID, "sync-failed")


def test_lock_contention_happens_before_claim_and_leaves_request_queued():
    remote = Mock(owner_id=OWNER)

    @contextmanager
    def unavailable(_name: str):
        raise ProcessLockUnavailable
        yield

    worker = AirfareRequestWorker(remote, lock_factory=unavailable)

    assert asyncio.run(worker.reconcile_once()) is True
    remote.claim_request.assert_not_called()


def test_one_lock_drains_the_airfare_queue_in_order():
    remote = Mock(owner_id=OWNER)
    second = CollectorRequest(
        UUID("33333333-3333-3333-3333-333333333333"),
        OWNER,
        "airfare-route",
        {"origin": "LIM", "destination": "AQP", "month": "2026-11", "currency": "USD"},
        datetime.now(UTC) + timedelta(minutes=30),
    )
    remote.claim_request.side_effect = [request(), second, None]
    collect_route = AsyncMock(return_value=report())

    assert (
        asyncio.run(
            worker_for(
                remote, collect_route=collect_route, sync_pass=Mock(return_value=True)
            ).reconcile_once()
        )
        is True
    )

    assert collect_route.await_count == 2


def test_run_wakes_immediately_and_stops_without_waiting_for_poll_interval():
    async def scenario():
        remote = Mock(owner_id=OWNER)
        worker = worker_for(remote)
        worker.reconcile_once = AsyncMock(return_value=True)
        stopped = asyncio.Event()
        heartbeat = Mock()
        task = asyncio.create_task(worker.run(stopped, heartbeat))
        await asyncio.sleep(0)
        worker.wake_requests()
        await asyncio.sleep(0)
        stopped.set()
        await asyncio.wait_for(task, timeout=0.2)
        return worker, heartbeat

    worker, heartbeat = asyncio.run(scenario())
    assert worker.reconcile_once.await_count >= 1
    assert heartbeat.call_count >= 1


def test_worker_never_reclaims_a_running_request_it_did_not_claim():
    remote = Mock(owner_id=OWNER)
    remote.claim_request.return_value = None

    assert asyncio.run(worker_for(remote).reconcile_once()) is True

    remote.claim_request.assert_called_once_with(("airfare-route",))
    remote.complete_request.assert_not_called()
    remote.fail_request.assert_not_called()
