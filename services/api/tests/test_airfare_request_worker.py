"""Manual Airfare requests stay queued until the Pi can own the Airfare lock."""

from __future__ import annotations

import asyncio
import inspect
import json
import threading
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from unittest.mock import AsyncMock, Mock, call
from uuid import UUID

from app.services.airfare_request_worker import AirfareRequestWorker
from app.services.collector_cloud import CollectorRequest
from app.services.fare_collector import CollectionReport, RouteResult
from app.services.fare_passes import PassLedger, PassRecorder
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
    recorder_factory = kwargs.pop("recorder_factory", Mock(return_value=recorder))
    return AirfareRequestWorker(
        remote,
        lock_factory=available_lock,
        today=lambda: date(2026, 9, 19),
        recorder_factory=recorder_factory,
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


def test_a_partial_collection_syncs_what_it_got_and_completes_with_its_failures():
    """
    One unreadable departure used to fail the whole request and skip the sync,
    so the rest of the month never reached the page — ARI-SCL collected 26
    departures and threw them all away over 5. The scheduled pass has always
    kept what it got and recorded the rest; a manual press now does the same.
    """
    for collected, failed, skipped in (
        (report(failed=True), 1, 0),
        (report(skipped=[("LIM-CUZ 2026-11-04", "over-budget")]), 0, 1),
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

        assert healthy is True
        sync_pass.assert_called_once_with(collected)
        remote.fail_request.assert_not_called()
        remote.complete_request.assert_called_once()
        result = remote.complete_request.call_args.args[1]
        assert (result["lookedAt"], result["failed"], result["skipped"]) == (3, failed, skipped)


def test_real_manual_sync_accepts_partial_results_when_some_departures_were_read(monkeypatch):
    from app.services import airfare_request_worker as module
    from app.services.collection_sync import sync_completed_pass

    data = Mock()
    data.sync_manual_route.return_value = Mock(status="complete")
    monkeypatch.setattr(module, "AIRFARE_DATA", data)

    assert sync_completed_pass(data, report(failed=True)) is False
    data.sync_incremental.assert_not_called()
    for collected in (
        report(failed=True),
        report(skipped=[("LIM-CUZ 2026-11-04", "over-budget")]),
    ):
        remote = Mock(owner_id=OWNER)
        remote.claim_request.side_effect = [request(), None]
        worker = worker_for(remote, collect_route=AsyncMock(return_value=collected))

        assert asyncio.run(worker.reconcile_once()) is True
        remote.complete_request.assert_called_once()
        assert remote.complete_request.call_args.args[1]["synced"] is True
    assert data.sync_manual_route.call_args_list == [call("LIM", "CUZ"), call("LIM", "CUZ")]
    data.sync_incremental.assert_not_called()


def test_default_sync_uses_validated_request_route_instead_of_report_route(monkeypatch):
    from app.services import airfare_request_worker as module

    data = Mock()
    data.sync_manual_route.return_value = Mock(status="complete")
    monkeypatch.setattr(module, "AIRFARE_DATA", data)
    remote = Mock(owner_id=OWNER)
    remote.claim_request.side_effect = [
        request({"origin": "ARI", "destination": "SCL", "month": "2026-11", "currency": "USD"}),
        None,
    ]

    assert (
        asyncio.run(
            worker_for(remote, collect_route=AsyncMock(return_value=report())).reconcile_once()
        )
        is True
    )
    data.sync_manual_route.assert_called_once_with("ARI", "SCL")
    data.sync_incremental.assert_not_called()


def test_real_manual_sync_keeps_a_minority_of_successful_departures(monkeypatch):
    from app.services import airfare_request_worker as module

    data = Mock()
    data.sync_manual_route.return_value = Mock(status="complete")
    monkeypatch.setattr(module, "AIRFARE_DATA", data)
    collected = CollectionReport(
        "start",
        "finish",
        "google",
        [RouteResult("LIM", "CUZ", "2026-11-01", None, True)]
        + [
            RouteResult(
                "LIM", "CUZ", f"2026-11-{day:02d}", None, False, error_code="upstream-error"
            )
            for day in (2, 3)
        ],
        [],
    )
    remote = Mock(owner_id=OWNER)
    remote.claim_request.side_effect = [request(), None]

    assert (
        asyncio.run(
            worker_for(remote, collect_route=AsyncMock(return_value=collected)).reconcile_once()
        )
        is True
    )
    data.sync_manual_route.assert_called_once_with("LIM", "CUZ")
    assert remote.complete_request.call_args.args[1]["failed"] == 2


def test_a_collection_that_got_nothing_fails_without_syncing():
    nothing_read = CollectionReport(
        "start",
        "finish",
        "google",
        [
            RouteResult("LIM", "CUZ", "2026-11-01", None, False, error_code="parse-drift"),
            RouteResult("LIM", "CUZ", "2026-11-02", None, False, error_code="parse-drift"),
        ],
        [],
    )
    nothing_allowed = CollectionReport(
        "start", "finish", "google", [], [("LIM-CUZ 2026-11-01", "over-budget")]
    )
    for collected in (nothing_read, nothing_allowed):
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


def test_syncing_progress_failure_settles_the_request_safely():
    remote = Mock(owner_id=OWNER)
    remote.claim_request.side_effect = [request(), None]

    def update_progress(_request_id, progress):
        if progress["stage"] == "syncing":
            raise RuntimeError("private cloud detail")

    remote.update_request_progress.side_effect = update_progress
    sync_pass = Mock(return_value=True)

    healthy = asyncio.run(
        worker_for(
            remote,
            collect_route=AsyncMock(return_value=report()),
            sync_pass=sync_pass,
        ).reconcile_once()
    )

    assert healthy is False
    sync_pass.assert_not_called()
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


def test_the_real_route_collection_announces_its_total_before_the_first_departure(monkeypatch):
    """
    The scheduled pass announces its plan in `collect_due`; the manual path calls
    `collect` directly and announced nothing, so a row's bar had no denominator
    until the pass was over and swept "unknown length" for the whole collection.
    The tests above fake the route collection and announce the plan themselves,
    which is how that went unnoticed.
    """
    from app.services import airfare_request_worker as module
    from app.services.fare_collector import FareWatch

    events: list[tuple] = []

    async def fake_collect(queries, *, observer, pass_id, gap_seconds, max_in_flight):
        del pass_id
        events.append(("collect", len(queries), gap_seconds, max_in_flight))
        return report()

    class Observer:
        def planned(self, *, polling, skipped):
            events.append(("planned", polling))
            assert skipped == []

        def collected(self, result, snapshot=None):
            del result, snapshot

    monkeypatch.setattr(module, "collect", fake_collect)
    watch = FareWatch("LIM", "CUZ", "2026-11", "USD")

    asyncio.run(module._collect_route(watch, Observer(), "pass"))

    # November has 30 departures, and the total is known before any is polled.
    assert events == [("planned", 30), ("collect", 30, 0.05, 16)]


def test_manual_pass_records_collection_and_acknowledged_sync_durations(tmp_path):
    remote = Mock(owner_id=OWNER)
    sync_started = threading.Event()
    sync_ack = threading.Event()
    ledger = PassLedger(tmp_path / "passes")

    async def slow_collection(_watch, observer, _pass_id):
        observer.planned(polling=3, skipped=[])
        return report()

    def slow_sync(_report):
        sync_started.set()
        assert sync_ack.wait(1)
        return True

    def recorder_factory(**kwargs):
        return PassRecorder(**kwargs, ledger=ledger)

    ticks = iter((1.0, 1.025, 2.0, 2.04))
    worker = worker_for(
        remote,
        collect_route=slow_collection,
        sync_pass=slow_sync,
        recorder_factory=recorder_factory,
        clock=lambda: next(ticks),
    )

    async def scenario():
        task = asyncio.create_task(worker.serve_request(request()))
        assert await asyncio.to_thread(sync_started.wait, 1)
        assert not remote.complete_request.called
        sync_ack.set()
        assert await asyncio.wait_for(task, 1)

    asyncio.run(scenario())
    rows = list((tmp_path / "passes").glob("*.jsonl"))
    entry = json.loads(rows[0].read_text(encoding="utf-8").splitlines()[0])
    assert entry["gap"] == 0.05
    assert entry["collectionMs"] == 25
    assert entry["syncMs"] == 40
    assert remote.complete_request.called


def test_manual_options_match_the_real_collector_signature():
    from app.services import airfare_request_worker as module

    inspect.signature(module.collect).bind(
        [],
        gap_seconds=module.MANUAL_REQUEST_GAP_SECONDS,
        max_in_flight=module.MANUAL_MAX_IN_FLIGHT,
    )


def test_scheduled_recorder_keeps_existing_row_shape(tmp_path):
    ledger = PassLedger(tmp_path / "passes")
    PassRecorder(source="scheduler", kind="board", gap=3.0, ledger=ledger).finish(exit_code=0)

    entry = json.loads(
        next((tmp_path / "passes").glob("*.jsonl")).read_text(encoding="utf-8").splitlines()[0]
    )
    assert "collectionMs" not in entry
    assert "syncMs" not in entry


def test_manual_failure_records_only_stages_that_were_attempted():
    for stage in ("collection", "progress", "sync", "completion"):
        remote = Mock(owner_id=OWNER)
        recorder = Mock(pass_id="pass")
        collection = AsyncMock(return_value=report())
        sync = Mock(return_value=True)
        if stage == "collection":
            collection.side_effect = RuntimeError("collection failed")
        elif stage == "progress":

            def fail_syncing(_request_id, progress):
                if progress["stage"] == "syncing":
                    raise RuntimeError("progress failed")

            remote.update_request_progress.side_effect = fail_syncing
        elif stage == "sync":
            sync.side_effect = RuntimeError("sync failed")
        else:
            remote.complete_request.side_effect = RuntimeError("response lost")
        ticks = iter((1.0, 1.025, 2.0, 2.04))
        worker = worker_for(
            remote,
            collect_route=collection,
            sync_pass=sync,
            recorder_factory=Mock(return_value=recorder),
            clock=lambda clock_ticks=ticks: next(clock_ticks),
        )

        assert asyncio.run(worker.serve_request(request())) is False
        finish = recorder.finish.call_args.kwargs
        assert finish["exit_code"] == 1
        assert finish["collection_ms"] == 25
        assert finish.get("sync_ms") == (40 if stage in {"sync", "completion"} else None)
