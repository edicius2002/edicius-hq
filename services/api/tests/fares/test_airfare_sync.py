"""Synchronization contracts exercised with real files and the safe HTTP boundary."""

import hashlib
import importlib.util
import json
import multiprocessing
import os
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from app.services.airfare_baseline_ack import BaselineAcknowledgements
from app.services.airfare_supabase import (
    AirfareRemoteRejected,
    AirfareRemoteUnavailable,
    SupabaseAirfare,
)
from app.services.airfare_sync import AirfareSync, canonical_record_id

STAMP = "2026-09-15T00:00:00+00:00"
SNAPSHOT = {
    "capturedAt": STAMP,
    "source": "google-flights",
    "origin": "AQP",
    "destination": "LIM",
    "flightDate": "2027-03-01",
    "currency": "USD",
    "offers": [
        {
            "airline": "LA",
            "departureAt": "2027-03-01T12:00:00",
            "transfers": 0,
            "price": 123,
            "currency": "USD",
        }
    ],
    "extra": "á",
}
CALENDAR = {
    "capturedAt": STAMP,
    "source": "google-flights",
    "origin": "AQP",
    "destination": "LIM",
    "currency": "USD",
    "from": "2027-03-01",
    "to": "2027-03-03",
    "prices": {"2027-03-01": None, "2027-03-03": 90},
}
BASELINE = {
    "flightDate": "2027-03-01",
    "date": "2026-09-01",
    "price": 150,
    "currency": "USD",
    "source": "google-flights",
}
BOARD = {"at": STAMP, "flightDate": "2027-03-01", "outcome": "changed", "offers": 1}
CHECK = {"at": STAMP, "outcome": "error", "dates": 0, "errorCode": "refused"}
AIRPORT = {
    "code": "AQP",
    "name": "Rodríguez Ballón",
    "city": "Arequipa",
    "country": "Peru",
    "latitude": -16.34,
    "longitude": -71.58,
}
WATCH = {
    "version": 1,
    "routes": [{"origin": "AQP", "destination": "LIM", "months": ["2027-03"], "currency": "USD"}],
}
REPO = Path(__file__).resolve().parents[4]


def write_lines(root, relative, rows, *, tail=b""):
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(
        b"".join(json.dumps(row, ensure_ascii=False).encode() + b"\n" for row in rows) + tail
    )
    return path


@pytest.fixture
def source(tmp_path):
    for relative, row in (
        ("fares/AQP-LIM.jsonl", SNAPSHOT),
        ("fares/baseline/AQP-LIM.jsonl", BASELINE),
        ("fares/calendar/AQP-LIM.jsonl", CALENDAR),
        ("fares/checks/AQP-LIM.jsonl", BOARD),
        ("fares/calendar/checks/AQP-LIM.jsonl", CHECK),
    ):
        write_lines(tmp_path, relative, [row], tail=b"broken\n\n")
    (tmp_path / "fares/airports.json").write_text(json.dumps({"AQP": AIRPORT}), encoding="utf-8")
    (tmp_path / "kv").mkdir()
    (tmp_path / "kv/airfare-routes.json").write_text(json.dumps(WATCH), encoding="utf-8")
    return tmp_path


class Destination:
    """Minimal stateful PostgREST server; no hosted connection is possible."""

    def __init__(self):
        self.tables = {}
        self.requests = []
        self.fail_table = None
        self.fail_after = 0
        self.history = None
        self.calendar = None
        self.dirty_routes = []
        self.projection_refreshes = []

    def handle(self, request):
        self.requests.append(request)
        table = request.url.path.split("/")[-1]
        if table == self.fail_table:
            if self.fail_after == 0:
                return httpx.Response(503, text="sb_secret_DO_NOT_REPORT")
            self.fail_after -= 1
        if request.method == "GET":
            rows = list(self.tables.get(table, {}).values())
            offset = int(request.url.params.get("offset", 0))
            limit = min(int(request.url.params.get("limit", 1000)), 2)
            columns = request.url.params["select"].split(",")
            return httpx.Response(
                200, json=[{k: row[k] for k in columns} for row in rows[offset : offset + limit]]
            )
        body = json.loads(request.content)
        if table == "list_fare_projection_dirty_routes":
            return httpx.Response(200, json=self.dirty_routes)
        if table == "refresh_fare_route_projection":
            route = (body["p_origin"], body["p_destination"])
            self.projection_refreshes.append(route)
            self.dirty_routes = [
                item for item in self.dirty_routes if (item["origin"], item["destination"]) != route
            ]
            return httpx.Response(200, json=1)
        if table == "airfare_dataset_manifest":
            groups = {}
            for name, dataset in (
                ("fare_snapshots", "snapshots"),
                ("fare_baseline_points", "baseline"),
                ("fare_calendar_captures", "calendar"),
                ("fare_checks", None),
            ):
                for row in self.tables.get(name, {}).values():
                    key = (
                        dataset or row["kind"] + "_checks",
                        row["origin"] + "-" + row["destination"],
                    )
                    groups.setdefault(key, []).append(row["record_id"])
            return httpx.Response(
                200,
                json=[
                    {
                        "dataset": d,
                        "route": r,
                        "count": len(ids),
                        "digest": hashlib.sha256("\n".join(sorted(ids)).encode()).hexdigest(),
                    }
                    for (d, r), ids in sorted(groups.items())
                ],
            )
        if table in {"read_airfare_history_meta", "read_airfare_history_page"}:
            filters = {
                k: v
                for k, v in body.items()
                if k
                in {
                    "p_origin",
                    "p_destination",
                    "p_departure",
                    "p_snapshot_months",
                    "p_since",
                    "p_until",
                }
            }
            key = hashlib.md5(json.dumps(filters, sort_keys=True).encode()).hexdigest()
            envelope = {"protocolVersion": 1, "queryKey": key, "revision": "1"}
            if table == "read_airfare_history_meta":
                return httpx.Response(
                    200,
                    json={
                        **envelope,
                        **{
                            k: v
                            for k, v in self.history.items()
                            if k not in {"snapshots", "baseline"}
                        },
                        "counts": {k: str(len(self.history[k])) for k in ("snapshots", "baseline")},
                    },
                )
            dataset = body["p_dataset"]
            items = []
            for n, payload in enumerate(self.history[dataset], 1):
                record_id = canonical_record_id(
                    "snapshot" if dataset == "snapshots" else "baseline",
                    body["p_origin"],
                    body["p_destination"],
                    payload,
                )
                if dataset == "snapshots":
                    stored = self.tables.get("fare_snapshots", {}).get(record_id, {})
                    last_line = max(
                        (
                            row["source_line"]
                            for row in self.tables.get("fare_snapshots", {}).values()
                        ),
                        default=0,
                    )
                    order = [
                        payload["capturedAt"],
                        str(stored.get("source_line", last_line + n)),
                        record_id,
                    ]
                else:
                    order = [payload["flightDate"], payload["date"], record_id]
                items.append({"recordId": record_id, "order": order, "payload": payload})
            return httpx.Response(
                200, json={**envelope, "dataset": dataset, "items": items, "nextCursor": None}
            )
        if table == "read_airfare_calendar":
            return httpx.Response(200, json=self.calendar)
        keys = request.url.params["on_conflict"].split(",")

        def identity(row):
            return row[keys[0]] if len(keys) == 1 else tuple(row[key] for key in keys)

        assert len({identity(row) for row in body}) == len(body), (
            "duplicate keys break a Postgres upsert"
        )
        target = self.tables.setdefault(table, {})
        for row in body:
            target[identity(row)] = row
        return httpx.Response(201)


class ProcessDestination:
    """Cross-process remote double that pauses one stale baseline write."""

    def __init__(self, state, attempted, release, *, pause):
        self.state = state
        self.attempted = attempted
        self.release = release
        self.pause = pause

    def upsert(self, table, rows, *, on_conflict):
        del on_conflict
        if table != "fare_baseline_points":
            return
        self.attempted.set()
        if self.pause and not self.release.wait(10):
            raise TimeoutError("test did not release the paused synchronization")
        self.state["baseline_price"] = rows[0]["price"]

    def rpc(self, name, params, *, timeout_seconds=None):
        if name == "list_fare_projection_dirty_routes":
            assert params == {}
            return []
        assert name == "airfare_dataset_manifest"
        assert params == {}
        return []


def apply_baseline_in_process(source, state, attempted, release, ready, *, pause):
    ready.set()
    report = AirfareSync(
        Path(source), ProcessDestination(state, attempted, release, pause=pause)
    ).apply("full")
    if report.status != "complete":
        raise AssertionError(report.error)


@pytest.fixture
def remote():
    destination = Destination()
    client = SupabaseAirfare(
        "https://testproject.supabase.co",
        "sb_secret_test",
        transport=httpx.MockTransport(destination.handle),
        history_transport=httpx.MockTransport(destination.handle),
    )
    yield destination, client
    client.close()


def test_canonical_identity_is_utf8_sorted_and_route_scoped():
    expected = hashlib.sha256('snapshot\nAQP-LIM\n{"a":"á","b":2}'.encode()).hexdigest()
    assert canonical_record_id("snapshot", "aqp", "lim", {"b": 2, "a": "á"}) == expected
    assert canonical_record_id("snapshot", "LIM", "AQP", {"a": "á", "b": 2}) != expected
    with pytest.raises(ValueError):
        canonical_record_id("snapshot", "AQP", "LIM", {"price": float("nan")})


def test_scan_counts_corrupt_blank_duplicate_and_partial_lines_without_writes(source):
    path = source / "fares/AQP-LIM.jsonl"
    with path.open("ab") as handle:
        handle.write(json.dumps(SNAPSHOT).encode() + b"\n" + json.dumps(SNAPSHOT).encode())
    before = {p: p.read_bytes() for p in source.rglob("*") if p.is_file()}
    manifest = AirfareSync(source).scan("full")
    assert (
        manifest.snapshots.physical_valid,
        manifest.snapshots.logical_unique,
        manifest.snapshots.skipped,
    ) == (2, 1, 1)
    for name in ("baseline", "calendar", "board_checks", "calendar_checks"):
        item = getattr(manifest, name)
        assert (item.physical_valid, item.logical_unique, item.skipped) == (1, 1, 1)
        assert list(item.by_route) == ["AQP-LIM"]
    assert manifest.airports.logical_unique == manifest.documents.logical_unique == 1
    assert before == {p: p.read_bytes() for p in source.rglob("*") if p.is_file()}


def test_full_replay_preserves_payload_and_source_positions(source, remote):
    server, client = remote
    path = source / "fares/calendar/AQP-LIM.jsonl"
    path.write_bytes(b"\nbroken\n" + json.dumps(CALENDAR).encode() + b"\n")
    sync = AirfareSync(source, client, batch_size=2)
    assert sync.apply("full").status == "complete"
    counts = {k: len(v) for k, v in server.tables.items() if k != "airfare_import_runs"}
    assert sync.apply("full").status == "complete"
    assert counts == {k: len(v) for k, v in server.tables.items() if k != "airfare_import_runs"}
    snapshot = next(iter(server.tables["fare_snapshots"].values()))
    assert snapshot["payload"] == SNAPSHOT
    assert snapshot["cheapest_price"] == 123
    curve = next(iter(server.tables["fare_calendar_captures"].values()))
    assert curve["payload"] == CALENDAR
    assert curve["source_line"] == 3
    assert server.tables["airfare_documents"]["airfare-routes"]["value"] == WATCH
    assert server.tables["airfare_documents"]["airfare-routes"]["source_updated_at"]
    assert all(row["status"] == "complete" for row in server.tables["airfare_import_runs"].values())


def test_sync_refreshes_dirty_route_projection_after_upload(source, remote):
    server, client = remote
    server.dirty_routes = [{"origin": "AQP", "destination": "LIM"}]

    report = AirfareSync(source, client).apply("incremental")

    assert report.status == "complete"
    assert server.projection_refreshes == [("AQP", "LIM")]
    assert server.dirty_routes == []


@pytest.fixture(autouse=True)
def immediate_finalization_retries(monkeypatch):
    monkeypatch.setattr(
        "app.services.airfare_sync._FINALIZATION_RETRY_DELAYS", (0.0, 0.0), raising=False
    )


@pytest.mark.parametrize(
    "manual,endpoint",
    [
        (False, "refresh_fare_route_projection"),
        (False, "airfare_dataset_manifest"),
        (False, "complete_run"),
        (True, "refresh_fare_route_projection"),
        (True, "complete_run"),
    ],
)
def test_transient_finalization_failure_recovers_without_reuploading(
    source, manual, endpoint, caplog, monkeypatch
):
    server = Destination()
    server.dirty_routes = [{"origin": "AQP", "destination": "LIM"}]
    attempts = 0
    baseline_confirmations = []
    confirm = BaselineAcknowledgements.confirm

    def record_confirm(checkpoint, records, **kwargs):
        baseline_confirmations.append(dict(records))
        confirm(checkpoint, records, **kwargs)

    monkeypatch.setattr(BaselineAcknowledgements, "confirm", record_confirm)

    def handle(request):
        nonlocal attempts
        name = request.url.path.split("/")[-1]
        body = json.loads(request.content)
        is_target = name == endpoint or (
            endpoint == "complete_run"
            and name == "airfare_import_runs"
            and body[0]["status"] == "complete"
        )
        if is_target:
            attempts += 1
            if attempts == 1:
                # A remote commit followed by a lost response must be safe.
                if endpoint == "complete_run":
                    server.handle(request)
                return httpx.Response(
                    500, json={"code": "57014", "message": "sb_secret_DO_NOT_REPORT"}
                )
        return server.handle(request)

    client = SupabaseAirfare(
        "https://testproject.supabase.co",
        "sb_secret_test",
        transport=httpx.MockTransport(handle),
    )
    try:
        sync = AirfareSync(source, client)
        report = sync.apply_manual_route("AQP", "LIM") if manual else sync.apply("incremental")
    finally:
        client.close()

    assert report.status == "complete"
    assert attempts == 2
    assert report.uploaded["snapshots"] == report.uploaded["baseline"] == 1
    assert sum(r.url.path.endswith("/fare_snapshots") for r in server.requests) == 1
    assert sum(r.url.path.endswith("/fare_baseline_points") for r in server.requests) == 1
    assert len(baseline_confirmations) == 1
    assert len(server.tables["airfare_import_runs"]) == 1
    run = next(iter(server.tables["airfare_import_runs"].values()))
    assert run["status"] == "complete"
    if manual:
        assert run["destination_manifest"] == {}
        assert not any(
            r.url.path.endswith(
                ("/rpc/airfare_dataset_manifest", "/rpc/list_fare_projection_dirty_routes")
            )
            for r in server.requests
        )
        expected_refreshes = 1 if endpoint == "refresh_fare_route_projection" else 2
        assert server.projection_refreshes == [("AQP", "LIM")] * expected_refreshes
    else:
        assert run["destination_manifest"]
    assert "57014" in caplog.text
    assert "sb_secret_DO_NOT_REPORT" not in caplog.text


@pytest.mark.parametrize("status,expected_attempts", [(500, 3), (403, 1)])
def test_finalization_failure_is_bounded_and_never_claims_success(
    source, status, expected_attempts, caplog
):
    server = Destination()
    attempts = 0
    failing = True

    def handle(request):
        nonlocal attempts
        if failing and request.url.path.endswith("/rpc/airfare_dataset_manifest"):
            attempts += 1
            return httpx.Response(
                status, json={"code": "57014", "message": "sb_secret_DO_NOT_REPORT"}
            )
        return server.handle(request)

    client = SupabaseAirfare(
        "https://testproject.supabase.co",
        "sb_secret_test",
        transport=httpx.MockTransport(handle),
    )
    try:
        sync = AirfareSync(source, client)
        report = sync.apply("incremental")
        assert report.status == "failed" and attempts == expected_attempts
        assert next(iter(server.tables["airfare_import_runs"].values()))["status"] == "failed"
        assert "57014" in caplog.text
        assert "sb_secret_DO_NOT_REPORT" not in caplog.text + report.error
        failing = False
        resumed = sync.apply("incremental")
        assert resumed.status == "complete" and resumed.uploaded["snapshots"] == 0
        assert resumed.uploaded["baseline"] == 0
    finally:
        client.close()


def test_lost_final_write_responses_never_claim_confirmed_success(source, caplog):
    server = Destination()
    final_attempts = []

    def handle(request):
        if request.url.path.endswith("/airfare_import_runs"):
            run = json.loads(request.content)[0]
            if run["status"] == "complete":
                final_attempts.append(run["run_id"])
                server.handle(request)
                raise httpx.ReadTimeout("sb_secret_DO_NOT_REPORT", request=request)
            if run["status"] == "failed":
                return httpx.Response(503, text="sb_secret_DO_NOT_REPORT")
        return server.handle(request)

    client = SupabaseAirfare(
        "https://testproject.supabase.co",
        "sb_secret_test",
        transport=httpx.MockTransport(handle),
    )
    try:
        report = AirfareSync(source, client).apply("incremental")
    finally:
        client.close()
    assert report.status == "failed"
    assert "import-run status could not be recorded" in report.error
    assert len(final_attempts) == 3 and len(set(final_attempts)) == 1
    assert len(server.tables["airfare_import_runs"]) == 1
    assert sum(r.url.path.endswith("/fare_snapshots") for r in server.requests) == 1
    assert "sb_secret_DO_NOT_REPORT" not in caplog.text + report.error


def test_manifest_timeout_exceeds_its_database_deadline(source, remote):
    server, client = remote
    assert AirfareSync(source, client).apply("incremental").status == "complete"
    request = next(
        r for r in server.requests if r.url.path.endswith("/rpc/airfare_dataset_manifest")
    )
    assert request.extensions["timeout"]["read"] == 35


def test_scoped_sync_skips_global_manifest_and_dirty_route_list(source, remote):
    server, client = remote
    server.dirty_routes = [{"origin": "AQP", "destination": "LIM"}]

    report = AirfareSync(source, client).apply(
        "incremental",
        collect_destination_manifest=False,
        projection_routes=frozenset({("AQP", "LIM")}),
    )

    assert report.status == "complete"
    assert server.projection_refreshes == [("AQP", "LIM")]
    assert {
        request.url.path.split("/")[-1]
        for request in server.requests
        if "/rpc/" in request.url.path
    } == {"refresh_fare_route_projection"}
    run = next(iter(server.tables["airfare_import_runs"].values()))
    assert run["status"] == "complete"
    assert run["destination_manifest"] == {}


def test_scoped_sync_refreshes_dirty_route_without_new_uploads(tmp_path, remote):
    server, client = remote
    write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply("incremental").status == "complete"
    server.requests.clear()
    server.projection_refreshes.clear()
    server.dirty_routes = [{"origin": "AQP", "destination": "LIM"}]

    report = sync.apply(
        "incremental",
        collect_destination_manifest=False,
        projection_routes=frozenset({("AQP", "LIM")}),
    )

    assert report.status == "complete"
    assert all(count == 0 for count in report.uploaded.values())
    assert server.projection_refreshes == [("AQP", "LIM")]
    assert server.dirty_routes == []


def test_scoped_sync_preserves_unrelated_dirty_route(source, remote):
    server, client = remote
    unrelated = {"origin": "LIM", "destination": "CUZ"}
    server.dirty_routes = [unrelated, {"origin": "AQP", "destination": "LIM"}]

    report = AirfareSync(source, client).apply(
        "incremental",
        collect_destination_manifest=False,
        projection_routes=frozenset({("AQP", "LIM")}),
    )

    assert report.status == "complete"
    assert server.projection_refreshes == [("AQP", "LIM")]
    assert server.dirty_routes == [unrelated]


def test_scoped_sync_still_fails_when_required_projection_refresh_fails(source, remote):
    server, client = remote
    server.dirty_routes = [{"origin": "AQP", "destination": "LIM"}]
    server.fail_table = "refresh_fare_route_projection"

    report = AirfareSync(source, client).apply(
        "incremental",
        collect_destination_manifest=False,
        projection_routes=frozenset({("AQP", "LIM")}),
    )

    assert report.status == "failed"
    assert server.dirty_routes == [{"origin": "AQP", "destination": "LIM"}]
    run = next(iter(server.tables["airfare_import_runs"].values()))
    assert run["status"] == "failed"
    assert run["destination_manifest"] == {}
    assert any(
        request.url.path.endswith("/rpc/refresh_fare_route_projection")
        for request in server.requests
    )


def test_projection_refresh_allows_a_longer_rpc_than_regular_uploads(source, remote):
    server, client = remote
    server.dirty_routes = [{"origin": "AQP", "destination": "LIM"}]

    assert AirfareSync(source, client).apply("incremental").status == "complete"

    projection_request = next(
        request
        for request in server.requests
        if request.url.path.endswith("/rpc/refresh_fare_route_projection")
    )
    upload_request = next(
        request for request in server.requests if request.url.path.endswith("/fare_snapshots")
    )
    assert projection_request.extensions["timeout"]["read"] == 65
    assert upload_request.extensions["timeout"]["read"] == 15


def test_failed_projection_refresh_is_retried_after_cursors_advance(source, remote):
    server, client = remote
    server.dirty_routes = [{"origin": "AQP", "destination": "LIM"}]
    server.fail_table = "refresh_fare_route_projection"
    sync = AirfareSync(source, client)

    assert sync.apply("incremental").status == "failed"
    assert server.dirty_routes == [{"origin": "AQP", "destination": "LIM"}]

    server.fail_table = None
    retry = sync.apply("incremental")
    assert retry.status == "complete" and retry.uploaded["baseline"] == 0
    assert server.projection_refreshes == [("AQP", "LIM")]


def test_failed_projection_refresh_logs_route_and_safe_status(source, remote, caplog):
    server, client = remote
    server.dirty_routes = [{"origin": "AQP", "destination": "LIM"}]
    server.fail_table = "refresh_fare_route_projection"

    report = AirfareSync(source, client).apply("incremental")

    assert report.status == "failed"
    assert "AQP-LIM" in caplog.text
    assert "503" in caplog.text
    assert "sb_secret_DO_NOT_REPORT" not in caplog.text


def test_apply_serializes_processes_before_scanning_a_rewritten_baseline(tmp_path):
    """Catch a stale scan finishing after a newer cross-process synchronization."""
    baseline_path = write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE])
    context = multiprocessing.get_context("spawn")
    with context.Manager() as manager:
        state = manager.dict()
        release_first = context.Event()
        first_attempted = context.Event()
        second_attempted = context.Event()
        first_ready = context.Event()
        second_ready = context.Event()
        first = context.Process(
            target=apply_baseline_in_process,
            args=(tmp_path, state, first_attempted, release_first, first_ready),
            kwargs={"pause": True},
        )
        second = context.Process(
            target=apply_baseline_in_process,
            args=(tmp_path, state, second_attempted, release_first, second_ready),
            kwargs={"pause": False},
        )
        first.start()
        try:
            assert first_ready.wait(10)
            assert first_attempted.wait(10)
            newer = {**BASELINE, "price": 175}
            baseline_path.write_bytes(json.dumps(newer).encode() + b"\n")
            second.start()
            assert second_ready.wait(10)
            overlapped = second_attempted.wait(2)
        finally:
            release_first.set()
            first.join(10)
            if second.pid is not None:
                second.join(10)
            if first.is_alive():
                first.terminate()
            if second.pid is not None and second.is_alive():
                second.terminate()

        assert overlapped is False
        assert first.exitcode == second.exitcode == 0
        assert state["baseline_price"] == 175


def test_process_lock_lives_with_the_shared_archive_across_private_tmp_namespaces(tmp_path):
    sync = AirfareSync(tmp_path)

    assert sync.process_lock_path == tmp_path / "fares/sync/replica.lock"


def test_failed_batch_cursor_retry_partial_tail_and_replacement(tmp_path, remote):
    server, client = remote
    second = {**SNAPSHOT, "flightDate": "2027-03-02"}
    third = {**SNAPSHOT, "flightDate": "2027-03-03"}
    path = write_lines(
        tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT, second], tail=json.dumps(third).encode()
    )
    first_end = path.read_bytes().index(b"\n") + 1
    server.fail_table = "fare_snapshots"
    server.fail_after = 1
    sync = AirfareSync(tmp_path, client, batch_size=1)
    report = sync.apply("incremental")
    assert report.status == "failed" and "sb_secret" not in report.error
    cursor_path = tmp_path / "fares/sync/cursors.json"
    assert json.loads(cursor_path.read_text())["fares/AQP-LIM.jsonl"]["offset"] == first_end
    assert list(server.tables["airfare_import_runs"].values())[-1]["status"] == "failed"
    server.fail_table = None
    assert sync.apply("incremental").status == "complete"
    assert len(server.tables["fare_snapshots"]) == 2
    assert (
        json.loads(cursor_path.read_text())["fares/AQP-LIM.jsonl"]["offset"]
        == path.read_bytes().rindex(b"\n") + 1
    )
    with path.open("ab") as handle:
        handle.write(b"\n")
    assert sync.apply("incremental").uploaded["snapshots"] == 1
    assert len(server.tables["fare_snapshots"]) == 3
    # A truncation replays from zero and content identity keeps the destination stable.
    write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    assert sync.apply("incremental").uploaded["snapshots"] == 1
    assert len(server.tables["fare_snapshots"]) == 3
    replacement = {**SNAPSHOT, "flightDate": "2027-03-04"}
    write_lines(tmp_path, "fares/AQP-LIM.jsonl", [replacement])
    assert sync.apply("incremental").uploaded["snapshots"] == 1


def test_ambiguous_normalized_source_positions_fail_before_network(tmp_path, remote):
    server, client = remote
    write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    write_lines(tmp_path, "fares/A!QP-LIM.jsonl", [{**SNAPSHOT, "currency": "PEN"}])
    with pytest.raises(ValueError, match="ambiguous"):
        AirfareSync(tmp_path, client).scan("full")
    assert server.requests == []


def test_verify_detects_route_digest_and_document_drift(source, remote):
    server, client = remote
    sync = AirfareSync(source, client)
    assert sync.apply("full").status == "complete"
    assert sync.verify(sync.scan("full")).matches
    server.tables["airfare_documents"]["airfare-routes"]["value"] = {"routes": []}
    row = next(iter(server.tables["fare_snapshots"].values()))
    row["destination"] = "CUZ"
    result = sync.verify(sync.scan("full"))
    assert not result.matches
    assert "documents" in result.mismatches
    assert any("snapshots" in mismatch for mismatch in result.mismatches)


def test_cli_defaults_to_credential_free_dry_run_and_rejects_mixed_modes(source, tmp_path):
    report = tmp_path / "report.json"
    script = REPO / "scripts/fares-supabase.py"
    run = subprocess.run(
        [sys.executable, str(script), "--source", str(source), "--report", str(report)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode == 0, run.stderr
    data = json.loads(report.read_text())
    assert data["status"] == "complete" and data["source"]["snapshots"]["logical_unique"] == 1
    assert data["source_root"] == "<external-source>"
    assert str(source.resolve()) not in report.read_text()
    assert str(source.resolve()) not in run.stdout
    assert not (source / "fares/sync").exists()
    mixed = subprocess.run(
        [sys.executable, str(script), "--dry-run", "--apply"], capture_output=True, check=False
    )
    assert mixed.returncode == 2


def test_cli_report_uses_a_repo_relative_source_label_for_the_standard_archive(tmp_path):
    report = tmp_path / "report.json"
    run = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/fares-supabase.py"),
            "--source",
            "services/api/.local-data",
            "--report",
            str(report),
        ],
        capture_output=True,
        text=True,
        check=False,
    )

    assert run.returncode == 0, run.stderr
    data = json.loads(report.read_text())
    assert data["source_root"] == "services/api/.local-data"
    assert str((REPO / "services/api/.local-data").resolve()) not in report.read_text()
    assert str((REPO / "services/api/.local-data").resolve()) not in run.stdout


@pytest.mark.parametrize("duplicates", [False, True])
def test_compare_reads_uses_real_local_readers_and_reports_differences(source, remote, duplicates):
    server, client = remote
    spec = importlib.util.spec_from_file_location(
        "fares_supabase_cli", REPO / "scripts/fares-supabase.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    server.history = {
        "origin": "AQP",
        "destination": "LIM",
        "snapshots": [SNAPSHOT],
        "baseline": [BASELINE],
        "airports": [AIRPORT],
        "pairReference": {"value": 123, "dates": 1},
        "health": {"lastCheckedAt": STAMP, "checks": 1, "changes": 1, "errors": 0},
    }
    server.calendar = {
        "origin": "AQP",
        "destination": "LIM",
        "horizon": {
            "capturedAt": STAMP,
            "source": "google-flights",
            "currency": "USD",
            "fromDate": "2027-03-01",
            "toDate": "2027-03-03",
            "prices": [
                {"departureDate": "2027-03-01", "price": None, "observedAt": STAMP},
                {"departureDate": "2027-03-03", "price": 90, "observedAt": STAMP},
            ],
        },
        "health": {"lastCheckedAt": STAMP, "checks": 1, "changes": 0, "errors": 1},
    }
    if duplicates:
        for relative, row in (
            ("fares/AQP-LIM.jsonl", SNAPSHOT),
            ("fares/checks/AQP-LIM.jsonl", BOARD),
            ("fares/calendar/checks/AQP-LIM.jsonl", CHECK),
            ("fares/calendar/AQP-LIM.jsonl", CALENDAR),
            ("fares/baseline/AQP-LIM.jsonl", BASELINE),
        ):
            write_lines(source, relative, [row, row])
    sync = AirfareSync(source, client)
    applied = sync.apply("full")
    assert applied.status == "complete"
    assert sync.verify(applied.source).matches
    assert applied.source.snapshots.physical_valid == (2 if duplicates else 1)
    assert applied.source.snapshots.logical_unique == 1
    result = module.compare_reads(source, client)
    assert result["matches"] and result["routes"] == 1
    assert all(item["local_digest"] == item["remote_digest"] for item in result["comparisons"])
    server.calendar["horizon"]["prices"][1]["price"] = "90"
    assert module.compare_reads(source, client)["matches"]
    server.calendar["horizon"]["prices"][0]["price"] = 0
    result = module.compare_reads(source, client)
    assert not result["matches"] and "AQP-LIM:calendar" in result["mismatches"]


def test_compare_reads_bounds_snapshots_to_the_watched_months(source):
    april_snapshot = {**SNAPSHOT, "flightDate": "2027-04-01"}
    outside_watch = {**SNAPSHOT, "flightDate": "2027-05-01"}
    april_baseline = {**BASELINE, "flightDate": "2027-04-01"}
    april_board = {**BOARD, "flightDate": "2027-04-01"}
    write_lines(source, "fares/AQP-LIM.jsonl", [SNAPSHOT, april_snapshot, outside_watch])
    write_lines(source, "fares/baseline/AQP-LIM.jsonl", [BASELINE, april_baseline])
    write_lines(source, "fares/checks/AQP-LIM.jsonl", [BOARD, april_board])
    (source / "kv/airfare-routes.json").write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "origin": "AQP",
                        "destination": "LIM",
                        "months": ["2027-04", "2027-03"],
                        "currency": "USD",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    spec = importlib.util.spec_from_file_location(
        "fares_supabase_cli", REPO / "scripts/fares-supabase.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    calls = []

    class BoundedRemote:
        def rpc(self, name, params):
            if name == "read_airfare_calendar":
                return {
                    "origin": "AQP",
                    "destination": "LIM",
                    "horizon": {
                        "capturedAt": STAMP,
                        "source": "google-flights",
                        "currency": "USD",
                        "fromDate": "2027-03-01",
                        "toDate": "2027-03-03",
                        "prices": [
                            {
                                "departureDate": "2027-03-01",
                                "price": None,
                                "observedAt": STAMP,
                            },
                            {"departureDate": "2027-03-03", "price": 90, "observedAt": STAMP},
                        ],
                    },
                    "health": {
                        "lastCheckedAt": STAMP,
                        "checks": 1,
                        "changes": 0,
                        "errors": 1,
                    },
                }

        def read_history(self, params):
            calls.append(params)
            month = params["p_departure"]
            snapshot = SNAPSHOT if month == "2027-03" else april_snapshot
            baseline = BASELINE if month == "2027-03" else april_baseline
            return {
                "origin": "AQP",
                "destination": "LIM",
                "snapshots": [SNAPSHOT, april_snapshot]
                if len(params["p_snapshot_months"]) == 2
                else [snapshot],
                "baseline": [baseline],
                "airports": [AIRPORT],
                # Pair reference stays pair-wide and includes the month outside the watch.
                "pairReference": {"value": 123, "dates": 3},
                "health": {
                    "lastCheckedAt": STAMP,
                    "checks": 1,
                    "changes": 1,
                    "errors": 0,
                },
            }

    assert module.compare_reads(source, BoundedRemote())["matches"]
    assert [call["p_departure"] for call in calls] == ["2027-03", "2027-03", "2027-04", "2027-04"]
    assert [call["p_snapshot_months"] for call in calls] == [
        ["2027-03"],
        ["2027-03", "2027-04"],
        ["2027-04"],
        ["2027-03", "2027-04"],
    ]
    assert all(call["p_departure"] is not None for call in calls)


def test_compare_reads_propagates_remote_unavailable_instead_of_local_parity(source):
    spec = importlib.util.spec_from_file_location(
        "fares_supabase_strict_cli", REPO / "scripts/fares-supabase.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class UnavailableRemote:
        def read_history(self, params):
            raise AirfareRemoteUnavailable("late page unavailable")

    with pytest.raises(AirfareRemoteUnavailable):
        module.compare_reads(source, UnavailableRemote())


def test_compare_reads_rejects_more_than_twelve_months_before_remote_reads(source):
    months = [f"{2027 + index // 12}-{index % 12 + 1:02d}" for index in range(13)]
    (source / "kv/airfare-routes.json").write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "origin": "AQP",
                        "destination": "LIM",
                        "months": months,
                        "currency": "USD",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    spec = importlib.util.spec_from_file_location(
        "fares_supabase_cli", REPO / "scripts/fares-supabase.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class NoRemoteReads:
        def rpc(self, name, params):
            raise AssertionError(f"unexpected remote read: {name} {params}")

    with pytest.raises(ValueError, match="between one and twelve months"):
        module.compare_reads(source, NoRemoteReads())


@pytest.mark.parametrize("month", ["2027-3", "bad", "", 2027])
def test_compare_reads_rejects_malformed_months_before_remote_reads(source, month):
    (source / "kv/airfare-routes.json").write_text(
        json.dumps(
            {
                "version": 1,
                "routes": [
                    {
                        "origin": "AQP",
                        "destination": "LIM",
                        "months": [month],
                        "currency": "USD",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )
    spec = importlib.util.spec_from_file_location(
        "fares_supabase_cli", REPO / "scripts/fares-supabase.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    class NoRemoteReads:
        def rpc(self, name, params):
            raise AssertionError(f"unexpected remote read: {name} {params}")

    with pytest.raises(ValueError, match="YYYY-MM"):
        module.compare_reads(source, NoRemoteReads())


def test_verification_reads_all_server_capped_pages(tmp_path, remote):
    server, client = remote
    write_lines(
        tmp_path,
        "fares/AQP-LIM.jsonl",
        [{**SNAPSHOT, "flightDate": f"2027-03-{day:02d}"} for day in range(1, 8)],
    )
    sync = AirfareSync(tmp_path, client, batch_size=3)
    assert sync.apply("full").uploaded["snapshots"] == 7
    result = sync.verify(sync.scan("full"))
    assert result.matches and result.destination.snapshots.records == 7
    snapshot_reads = [
        request
        for request in server.requests
        if request.method == "GET" and request.url.path.endswith("fare_snapshots")
    ]
    assert len(snapshot_reads) == 5


def test_first_batch_failure_does_not_acknowledge_any_source_bytes(tmp_path, remote):
    server, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    before = path.read_bytes()
    server.fail_table = "fare_snapshots"
    report = AirfareSync(tmp_path, client).apply("full")
    assert report.status == "failed" and report.uploaded["snapshots"] == 0
    assert not (tmp_path / "fares/sync/cursors.json").exists()
    assert path.read_bytes() == before


def test_cli_report_cannot_overwrite_an_authoritative_journal(source):
    path = source / "fares/AQP-LIM.jsonl"
    before = path.read_bytes()
    run = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/fares-supabase.py"),
            "--source",
            str(source),
            "--report",
            str(path),
        ],
        capture_output=True,
        check=False,
    )
    assert run.returncode == 2
    assert path.read_bytes() == before


def test_source_line_counts_only_lf_physical_lines(tmp_path, remote):
    server, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [])
    # A standalone CR is whitespace within line 1, not another JSONL line.
    path.write_bytes(b" \r \ninvalid\n" + json.dumps(SNAPSHOT).encode() + b"\n")
    sync = AirfareSync(tmp_path, client)
    assert sync.apply("full").status == "complete"
    assert next(iter(server.tables["fare_snapshots"].values()))["source_line"] == 3


def test_rewritten_baseline_updates_natural_key_without_leaving_old_content(source, remote):
    server, client = remote
    sync = AirfareSync(source, client)
    assert sync.apply("full").status == "complete"
    old = next(iter(server.tables["fare_baseline_points"].values()))["record_id"]
    write_lines(source, "fares/baseline/AQP-LIM.jsonl", [{**BASELINE, "price": 160}])
    assert sync.apply("incremental").status == "complete"
    assert len(server.tables["fare_baseline_points"]) == 1
    new = next(iter(server.tables["fare_baseline_points"].values()))
    assert new["price"] == 160 and new["record_id"] != old
    assert sync.verify(sync.scan("full")).matches


def test_unchanged_baseline_is_not_reuploaded_after_full_or_incremental_sync(source, remote):
    server, client = remote
    sync = AirfareSync(source, client)

    assert sync.apply("full").uploaded["baseline"] == 1
    cursor = json.loads((source / "fares/sync/cursors.json").read_text())
    baseline_path = source / "fares/baseline/AQP-LIM.jsonl"
    assert cursor["fares/baseline/AQP-LIM.jsonl"]["offset"] == baseline_path.stat().st_size

    server.requests.clear()
    assert sync.apply("incremental").uploaded["baseline"] == 0
    assert not any(request.url.path.endswith("fare_baseline_points") for request in server.requests)
    assert sync.apply("full").uploaded["baseline"] == 1


def test_rewritten_baseline_reuploads_only_its_route(source, remote):
    server, client = remote
    other = {**BASELINE, "flightDate": "2027-04-01"}
    write_lines(source, "fares/baseline/LIM-CUZ.jsonl", [other])
    sync = AirfareSync(source, client)
    assert sync.apply("incremental").uploaded["baseline"] == 2

    write_lines(source, "fares/baseline/AQP-LIM.jsonl", [{**BASELINE, "price": 160}])
    server.requests.clear()
    assert sync.apply("incremental").uploaded["baseline"] == 1
    uploads = [
        request for request in server.requests if request.url.path.endswith("fare_baseline_points")
    ]
    assert len(uploads) == 1
    assert json.loads(uploads[0].content)[0]["origin"] == "AQP"


def test_rewritten_baseline_uploads_only_new_natural_keys(source, remote):
    server, client = remote
    old = {**BASELINE, "date": "2026-09-02", "price": 151}
    added = {**BASELINE, "date": "2026-09-03", "price": 152}
    write_lines(source, "fares/baseline/AQP-LIM.jsonl", [BASELINE, old])
    sync = AirfareSync(source, client)
    assert sync.apply("incremental").uploaded["baseline"] == 2

    replacement = write_lines(source, "baseline-replacement.tmp", [BASELINE, old, added])
    os.replace(replacement, source / "fares/baseline/AQP-LIM.jsonl")
    server.requests.clear()
    report = sync.apply("incremental")

    assert report.status == "complete"
    assert report.uploaded["baseline"] == 1
    uploads = [
        request for request in server.requests if request.url.path.endswith("fare_baseline_points")
    ]
    assert len(uploads) == 1
    assert [row["price_date"] for row in json.loads(uploads[0].content)] == ["2026-09-03"]


def test_baseline_delta_retries_source_reversion_after_lost_response(tmp_path, remote, monkeypatch):
    server, client = remote
    path = write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply("incremental").status == "complete"
    revised = {**BASELINE, "price": 160}
    write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [revised])
    assert path.stat().st_size == len(json.dumps(BASELINE).encode()) + 1
    original_upsert = client.upsert
    lost = False

    def lose_baseline_response(table, rows, *, on_conflict):
        nonlocal lost
        original_upsert(table, rows, on_conflict=on_conflict)
        if table == "fare_baseline_points" and not lost:
            lost = True
            raise AirfareRemoteUnavailable("lost response after commit")

    monkeypatch.setattr(client, "upsert", lose_baseline_response)
    assert sync.apply("incremental").status == "failed"
    write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE])
    server.requests.clear()

    report = sync.apply("incremental")

    assert report.status == "complete"
    assert report.uploaded["baseline"] == 1
    assert next(iter(server.tables["fare_baseline_points"].values()))["price"] == 150


def test_failed_baseline_batch_resumes_after_the_last_confirmed_line(tmp_path, remote):
    server, client = remote
    next_point = {**BASELINE, "date": "2026-09-02", "price": 160}
    path = write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE, next_point])
    first_end = path.read_bytes().index(b"\n") + 1
    server.fail_table = "fare_baseline_points"
    server.fail_after = 1
    sync = AirfareSync(tmp_path, client, batch_size=1)

    failed = sync.apply("incremental")
    assert failed.status == "failed" and failed.uploaded["baseline"] == 1
    cursor = json.loads((tmp_path / "fares/sync/cursors.json").read_text())
    assert cursor["fares/baseline/AQP-LIM.jsonl"]["offset"] == first_end

    server.fail_table = None
    assert sync.apply("incremental").uploaded["baseline"] == 1
    assert len(server.tables["fare_baseline_points"]) == 2
    assert sync.apply("incremental").uploaded["baseline"] == 0


def test_successful_import_run_records_destination_route_manifest(source, remote):
    server, client = remote
    assert AirfareSync(source, client).apply("full").status == "complete"
    run = next(iter(server.tables["airfare_import_runs"].values()))
    assert run["destination_manifest"]
    assert run["destination_manifest"][0]["dataset"] == "baseline"
    assert "payload" not in json.dumps(run)


def test_manual_route_leaves_other_route_backlog_for_global_sync(source, remote):
    server, client = remote
    write_lines(
        source, "fares/LIM-CUZ.jsonl", [{**SNAPSHOT, "origin": "LIM", "destination": "CUZ"}]
    )
    sync = AirfareSync(source, client)

    report = sync.apply_manual_route("AQP", "LIM")

    assert report.status == "complete"
    assert report.uploaded == {
        "snapshots": 1,
        "baseline": 1,
        "calendar": 1,
        "board_checks": 1,
        "calendar_checks": 1,
        "airports": 0,
        "documents": 0,
    }
    cursor = json.loads(sync.cursor_path.read_text())
    assert "fares/AQP-LIM.jsonl" in cursor
    assert "fares/LIM-CUZ.jsonl" not in cursor
    assert server.projection_refreshes == [("AQP", "LIM")]
    assert not any(
        request.url.path.endswith(("airfare_dataset_manifest", "list_fare_projection_dirty_routes"))
        for request in server.requests
    )
    run = next(iter(server.tables["airfare_import_runs"].values()))
    assert run["source_manifest"]["scope"] == {
        "kind": "route",
        "origin": "AQP",
        "destination": "LIM",
    }
    assert set(run["source_manifest"]["datasets"]) == {
        "snapshots",
        "baseline",
        "calendar",
        "board_checks",
        "calendar_checks",
    }
    assert run["source_manifest"]["datasets"]["snapshots"]["logical_unique"] == 1
    assert run["destination_manifest"] == {}

    assert sync.apply("incremental").uploaded["snapshots"] == 1
    assert len(server.tables["fare_snapshots"]) == 2
    assert sync.verify(sync.scan()).matches


def test_manual_route_does_not_read_unrelated_journals_or_json_documents(source, remote):
    _, client = remote
    # Directories would fail when opened, proving the scoped scan never opens them.
    (source / "fares/LIM-CUZ.jsonl").mkdir()
    (source / "fares/airports.json").unlink()
    (source / "fares/airports.json").mkdir()
    (source / "kv/airfare-routes.json").unlink()
    (source / "kv/airfare-routes.json").mkdir()

    assert AirfareSync(source, client).apply_manual_route("AQP", "LIM").status == "complete"


def test_manual_route_includes_aliases_and_rejects_ambiguous_positions_before_network(
    tmp_path, remote
):
    server, client = remote
    write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    alias = write_lines(tmp_path, "fares/A!QP-LIM.jsonl", [{**SNAPSHOT, "currency": "PEN"}])
    sync = AirfareSync(tmp_path, client)

    with pytest.raises(ValueError, match="ambiguous"):
        sync.apply_manual_route("AQP", "LIM")
    assert server.requests == []

    # A nonambiguous alias is part of the same route and keeps physical positions.
    alias.write_bytes(b"\n" + alias.read_bytes())
    report = sync.apply_manual_route("AQP", "LIM")
    assert report.uploaded["snapshots"] == 2
    assert sorted(row["source_line"] for row in server.tables["fare_snapshots"].values()) == [1, 2]
    assert report.source.snapshots == sync.scan().snapshots


def test_manual_route_retries_failed_batch_and_replays_replaced_baseline(tmp_path, remote):
    server, client = remote
    write_lines(
        tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE, {**BASELINE, "date": "2026-09-02"}]
    )
    sync = AirfareSync(tmp_path, client, batch_size=1)
    server.fail_table, server.fail_after = "fare_baseline_points", 1

    assert sync.apply_manual_route("AQP", "LIM").status == "failed"
    server.fail_table = None
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 1
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 0

    replacement = tmp_path / "replacement.jsonl"
    replacement.write_text(json.dumps({**BASELINE, "price": 90}) + "\n", encoding="utf-8")
    replacement.replace(tmp_path / "fares/baseline/AQP-LIM.jsonl")
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 1
    assert any(row["price"] == 90 for row in server.tables["fare_baseline_points"].values())


@pytest.mark.parametrize("route", [("aqp", "LIM"), ("A!QP", "LIM"), ("AQP", "AQP"), (None, "LIM")])
def test_manual_route_rejects_invalid_scope_before_network(tmp_path, remote, route):
    server, client = remote
    with pytest.raises(ValueError, match="route"):
        AirfareSync(tmp_path, client).apply_manual_route(*route)
    assert server.requests == []


def test_ambiguous_baseline_natural_keys_are_rejected_before_upload(tmp_path, remote):
    server, client = remote
    write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE, {**BASELINE, "price": 160}])
    with pytest.raises(ValueError, match="ambiguous"):
        AirfareSync(tmp_path, client).scan("full")
    assert server.requests == []


def test_truncating_only_unacknowledged_tail_still_resets_cursor(tmp_path, remote):
    _, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT], tail=b'{"capturedAt":')
    sync = AirfareSync(tmp_path, client)
    assert sync.apply("incremental").uploaded["snapshots"] == 1
    with path.open("r+b") as handle:
        handle.truncate(path.read_bytes().index(b"\n") + 1)
    assert sync.apply("incremental").uploaded["snapshots"] == 1


def _directory_alias(alias: Path, target: Path) -> None:
    alias.parent.mkdir(parents=True, exist_ok=True)
    if sys.platform == "win32":
        result = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "New-Item -ItemType Junction -Path $env:AIRFARE_TEST_ALIAS -Target $env:AIRFARE_TEST_TARGET | Out-Null",
            ],
            env={
                **os.environ,
                "AIRFARE_TEST_ALIAS": str(alias),
                "AIRFARE_TEST_TARGET": str(target),
            },
            capture_output=True,
            text=True,
            check=False,
        )
        assert result.returncode == 0, result.stderr
    else:
        alias.symlink_to(target, target_is_directory=True)


@pytest.mark.parametrize("relative", ["fares", "kv", "fares/calendar", "fares/calendar/checks"])
@pytest.mark.parametrize("target_style", ["lexical", "resolved", "hardlink"])
def test_cli_report_aliases_never_overwrite_sources(tmp_path, relative, target_style):
    source, actual = tmp_path / "source", tmp_path / "actual"
    source.mkdir()
    actual.mkdir()
    filename = "airfare-routes.json" if relative == "kv" else "AQP-LIM.jsonl"
    row = (
        WATCH
        if relative == "kv"
        else CALENDAR
        if relative == "fares/calendar"
        else CHECK
        if relative.endswith("checks")
        else SNAPSHOT
    )
    journal = write_lines(actual, filename, [row])
    before = journal.read_bytes()
    _directory_alias(source / relative, actual)
    target = source / relative / filename if target_style == "lexical" else journal
    if target_style == "hardlink":
        target = tmp_path / "report.json"
        try:
            os.link(journal, target)
        except OSError:
            pytest.skip("filesystem does not support hardlinks")
    run = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/fares-supabase.py"),
            "--source",
            str(source),
            "--report",
            str(target),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert run.returncode == 2, run.stdout + run.stderr
    assert journal.read_bytes() == before
    assert target.read_bytes() == before
    assert not (source / "fares/sync").exists()


def test_cli_report_existing_external_directory_alias_is_refused(tmp_path):
    source = tmp_path / "source"
    journal = write_lines(source, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    before = journal.read_bytes()
    _directory_alias(tmp_path / "report-alias", source / "fares")
    run = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/fares-supabase.py"),
            "--source",
            str(source),
            "--report",
            str(tmp_path / "report-alias/AQP-LIM.jsonl"),
        ],
        capture_output=True,
        check=False,
    )
    assert run.returncode == 2
    assert journal.read_bytes() == before


@pytest.mark.parametrize(
    "dataset,relative,table,row",
    [
        ("snapshots", "fares/AQP-LIM.jsonl", "fare_snapshots", SNAPSHOT),
        ("calendar", "fares/calendar/AQP-LIM.jsonl", "fare_calendar_captures", CALENDAR),
    ],
)
def test_source_positions_replay_shifts_swaps_and_failed_batch_retry(
    tmp_path, remote, dataset, relative, table, row
):
    server, client = remote
    second = {**row, "currency": "PEN"}
    path = write_lines(tmp_path, relative, [row, second])
    sync = AirfareSync(tmp_path, client, batch_size=1)
    assert sync.apply("full").status == "complete"
    path.write_bytes(b"\n" + path.read_bytes())
    server.fail_table, server.fail_after = table, 1
    assert sync.apply("incremental").status == "failed"
    server.fail_table = None
    assert sync.apply("incremental").status == "complete"
    assert sorted(record["source_line"] for record in server.tables[table].values()) == [2, 3]
    write_lines(tmp_path, relative, [second, row])
    assert sync.apply("incremental").status == "complete"
    positions = {
        record["payload"]["currency"]: record["source_line"]
        for record in server.tables[table].values()
    }
    assert positions == {"PEN": 1, "USD": 2}
    assert sync.verify(sync.scan("full")).matches


def test_compare_logical_snapshots_retain_final_occurrence_and_detect_content_order(
    tmp_path, remote
):
    server, client = remote
    second = {**SNAPSHOT, "currency": "PEN"}
    write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT, second, SNAPSHOT])
    write_lines(tmp_path, "kv/airfare-routes.json", [WATCH])
    no_checks = {"lastCheckedAt": None, "checks": 0, "changes": 0, "errors": 0}
    server.history = {
        "origin": "AQP",
        "destination": "LIM",
        "snapshots": [second, SNAPSHOT],
        "baseline": [],
        "airports": [],
        "health": no_checks,
        "pairReference": {"value": 123, "dates": 1},
    }
    server.calendar = {"origin": "AQP", "destination": "LIM", "horizon": None, "health": no_checks}
    spec = importlib.util.spec_from_file_location(
        "fares_supabase_cli", REPO / "scripts/fares-supabase.py"
    )
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sync = AirfareSync(tmp_path, client, batch_size=1)
    assert sync.apply("full").status == "complete"
    assert sync.verify(sync.scan("full")).matches
    assert module.compare_reads(tmp_path, client)["matches"]
    server.history["snapshots"] = [SNAPSHOT, second]
    with pytest.raises(AirfareRemoteRejected):
        module.compare_reads(tmp_path, client)
    server.history["snapshots"] = [second, {**SNAPSHOT, "extra": "changed"}]
    assert not module.compare_reads(tmp_path, client)["matches"]


def test_cli_report_cannot_create_a_journal_through_an_empty_nested_alias(tmp_path):
    source, actual = tmp_path / "source", tmp_path / "actual"
    actual.mkdir()
    _directory_alias(source / "fares/calendar", actual)
    target = actual / "AQP-LIM.jsonl"
    run = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/fares-supabase.py"),
            "--source",
            str(source),
            "--report",
            str(target),
        ],
        capture_output=True,
        check=False,
    )
    assert run.returncode == 2
    assert not target.exists()


@pytest.mark.parametrize(
    "relative", ["fares/AQP-LIM.jsonl", "fares/airports.json", "kv/airfare-routes.json"]
)
@pytest.mark.parametrize("target_alias", [False, True])
def test_dangling_source_file_alias_cannot_be_populated_by_report(tmp_path, relative, target_alias):
    source = tmp_path / "source"
    external = tmp_path / "external"
    external.mkdir()
    target = external / "missing-report.json"
    source_link = source / relative
    source_link.parent.mkdir(parents=True)
    source_link.symlink_to(Path(os.path.relpath(target, source_link.parent)))
    original_link = os.readlink(source_link)
    report_target = target
    if target_alias:
        _directory_alias(tmp_path / "report-directory", external)
        report_target = tmp_path / "report-directory" / target.name
    run = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/fares-supabase.py"),
            "--source",
            str(source),
            "--report",
            str(report_target),
        ],
        capture_output=True,
        check=False,
    )
    assert run.returncode == 2
    assert not target.exists()
    assert source_link.is_symlink()
    assert os.readlink(source_link) == original_link
    assert not (source / "fares/sync").exists()


@pytest.mark.parametrize("existing_report", [False, True])
def test_dangling_source_alias_does_not_block_an_unrelated_report(tmp_path, existing_report):
    source = tmp_path / "source"
    (source / "fares").mkdir(parents=True)
    target = tmp_path / "external" / "missing-airports.json"
    target.parent.mkdir()
    source_link = source / "fares/airports.json"
    source_link.symlink_to(target)
    report = target.with_name("safe-report.json")
    if existing_report:
        report.write_text("old report", encoding="utf-8")
    run = subprocess.run(
        [
            sys.executable,
            str(REPO / "scripts/fares-supabase.py"),
            "--source",
            str(source),
            "--report",
            str(report),
        ],
        capture_output=True,
        check=False,
    )
    assert run.returncode == 0
    assert json.loads(report.read_text())["status"] == "complete"
    assert not target.exists() and source_link.is_symlink()


@pytest.mark.parametrize(
    "relative", ["fares/baseline/AQP-LIM.jsonl", "fares/baseline/A!QP-LIM.jsonl"]
)
@pytest.mark.parametrize("manual", [False, True])
def test_baseline_ack_recovers_legacy_writer_after_source_returns_to_old_content(
    tmp_path, remote, relative, manual
):
    server, client = remote
    path = write_lines(tmp_path, relative, [BASELINE])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply("incremental").uploaded["baseline"] == 1

    # f2b6481 rewrites a confirmed cursor after each baseline batch, without
    # maintaining the new ACK checkpoint. Exercise that same persisted boundary.
    write_lines(tmp_path, relative, [{**BASELINE, "price": 160}])
    datasets, journals = sync._collect()
    client.upsert(
        "fare_baseline_points",
        list(datasets["baseline"].rows.values()),
        on_conflict="origin,destination,flight_date,price_date",
    )
    sync._acknowledge(journals[0], journals[0].end, sync._cursors())
    write_lines(tmp_path, relative, [BASELINE])
    assert path.exists()

    report = sync.apply_manual_route("AQP", "LIM") if manual else sync.apply("incremental")
    assert report.status == "complete"
    assert report.uploaded["baseline"] == 1
    assert next(iter(server.tables["fare_baseline_points"].values()))["price"] == 150
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 0


def test_baseline_ack_detects_legacy_cursor_for_a_removed_route_alias(tmp_path, remote):
    server, client = remote
    canonical = write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply("incremental").uploaded["baseline"] == 1

    canonical.unlink()
    alias = write_lines(tmp_path, "fares/baseline/A!QP-LIM.jsonl", [{**BASELINE, "price": 160}])
    datasets, journals = sync._collect()
    client.upsert(
        "fare_baseline_points",
        list(datasets["baseline"].rows.values()),
        on_conflict="origin,destination,flight_date,price_date",
    )
    sync._acknowledge(journals[0], journals[0].end, sync._cursors())
    alias.unlink()
    write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE])

    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 1
    assert next(iter(server.tables["fare_baseline_points"].values()))["price"] == 150
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 0


@pytest.mark.parametrize("crash_boundary", ["cursor", "confirmation"])
def test_baseline_ack_replays_after_crash_between_remote_cursor_and_confirmation(
    tmp_path, remote, monkeypatch, crash_boundary
):
    server, client = remote
    write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply("incremental").uploaded["baseline"] == 1
    write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [{**BASELINE, "price": 160}])

    def crash(*args, **kwargs):
        raise OSError("simulated crash at local commit boundary")

    with monkeypatch.context() as patch:
        if crash_boundary == "cursor":
            patch.setattr(sync, "_acknowledge", crash)
        else:
            patch.setattr(BaselineAcknowledgements, "confirm", crash)
        assert sync.apply_manual_route("AQP", "LIM").status == "failed"
    assert next(iter(server.tables["fare_baseline_points"].values()))["price"] == 160

    write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE])
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 1
    assert next(iter(server.tables["fare_baseline_points"].values()))["price"] == 150
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 0


def test_baseline_cursor_binding_preserves_delta_uploads_across_coexisting_aliases(
    tmp_path, remote
):
    _, client = remote
    write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE])
    second = {**BASELINE, "date": "2026-09-02"}
    write_lines(tmp_path, "fares/baseline/A!QP-LIM.jsonl", [second])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 2
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 0

    third = {**BASELINE, "date": "2026-09-03"}
    replacement = write_lines(tmp_path, "replacement.jsonl", [second, third])
    replacement.replace(tmp_path / "fares/baseline/A!QP-LIM.jsonl")
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 1
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 0


def test_manual_route_reads_only_new_complete_lines_and_keeps_full_manifest(
    tmp_path, remote, monkeypatch
):
    server, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT] * 1000)
    sync = AirfareSync(tmp_path, client)
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1

    def forbid_full_scan(*args, **kwargs):
        raise AssertionError("manual delta read fell back to full scan")

    with monkeypatch.context() as patch:
        patch.setattr(sync, "_collect", forbid_full_scan)
        assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 0
        with path.open("ab") as handle:
            handle.write(json.dumps({**SNAPSHOT, "flightDate": "2027-03-02"}).encode() + b"\n")
        report = sync.apply_manual_route("AQP", "LIM")
        assert report.uploaded["snapshots"] == 1
        assert report.source.snapshots.physical_valid == 1001
        assert report.source.snapshots.logical_unique == 2
    assert report.source.snapshots == sync.scan().snapshots
    assert len(server.tables["fare_snapshots"]) == 2


def test_manual_route_baseline_delta_uses_ack_without_reparsing_history(
    tmp_path, remote, monkeypatch
):
    server, client = remote
    path = write_lines(tmp_path, "fares/baseline/AQP-LIM.jsonl", [BASELINE])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 1

    def forbid_full_scan(*args, **kwargs):
        raise AssertionError("baseline delta read fell back to full scan")

    with monkeypatch.context() as patch:
        patch.setattr(sync, "_collect", forbid_full_scan)
        with path.open("ab") as handle:
            handle.write(json.dumps({**BASELINE, "date": "2026-09-02"}).encode() + b"\n")
        assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 1
        assert sync.apply_manual_route("AQP", "LIM").uploaded["baseline"] == 0
    assert len(server.tables["fare_baseline_points"]) == 2


def test_manual_route_partial_line_then_completion_is_uploaded_once(tmp_path, remote):
    server, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    next_row = json.dumps({**SNAPSHOT, "flightDate": "2027-03-02"}).encode()
    with path.open("ab") as handle:
        handle.write(next_row[:20])
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 0
    with path.open("ab") as handle:
        handle.write(next_row[20:] + b"\n")
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 0
    assert len(server.tables["fare_snapshots"]) == 2


@pytest.mark.parametrize("change", ["replace", "truncate", "cursor"])
def test_manual_route_rebuilds_index_after_file_or_cursor_change(tmp_path, remote, change):
    server, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    newer = {**SNAPSHOT, "flightDate": "2027-03-02"}
    if change == "replace":
        replacement = write_lines(tmp_path, "replacement.jsonl", [newer])
        replacement.replace(path)
    elif change == "truncate":
        write_lines(tmp_path, "fares/AQP-LIM.jsonl", [newer])
    else:
        cursors = sync._cursors()
        cursors["fares/AQP-LIM.jsonl"]["offset"] = 1
        sync.cursor_path.write_text(json.dumps(cursors), encoding="utf-8")
        with path.open("ab") as handle:
            handle.write(json.dumps(newer).encode() + b"\n")
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] >= 1
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 0
    assert newer["flightDate"] in {
        row["flight_date"] for row in server.tables["fare_snapshots"].values()
    }


def test_manual_route_replays_unacknowledged_delta_after_network_failure(tmp_path, remote):
    server, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    with path.open("ab") as handle:
        handle.write(json.dumps({**SNAPSHOT, "flightDate": "2027-03-02"}).encode() + b"\n")
    server.fail_table = "fare_snapshots"
    assert sync.apply_manual_route("AQP", "LIM").status == "failed"
    server.fail_table = None
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 0
    assert len(server.tables["fare_snapshots"]) == 2


def test_manual_route_rebuilds_after_older_release_rewrites_cursor(tmp_path, remote):
    _, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    sync = AirfareSync(tmp_path, client)
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    datasets, journals = sync._collect(route_scope="AQP-LIM")
    assert datasets["snapshots"].physical == 1
    sync._acknowledge(journals[0], journals[0].end, sync._cursors())
    with path.open("ab") as handle:
        handle.write(json.dumps({**SNAPSHOT, "flightDate": "2027-03-02"}).encode() + b"\n")
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 0


def test_manual_route_replays_partial_delta_batch_after_network_failure(tmp_path, remote):
    server, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT])
    sync = AirfareSync(tmp_path, client, batch_size=1)
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    with path.open("ab") as handle:
        for day in (2, 3):
            handle.write(
                json.dumps({**SNAPSHOT, "flightDate": f"2027-03-{day:02d}"}).encode() + b"\n"
            )
    server.fail_table, server.fail_after = "fare_snapshots", 1
    assert sync.apply_manual_route("AQP", "LIM").status == "failed"
    server.fail_table = None
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 0
    assert len(server.tables["fare_snapshots"]) == 3


def test_global_sync_checks_full_prefix_after_manual_fast_cursor(tmp_path, remote):
    server, client = remote
    path = write_lines(tmp_path, "fares/AQP-LIM.jsonl", [SNAPSHOT] * 100)
    sync = AirfareSync(tmp_path, client)
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    with path.open("ab") as handle:
        handle.write(json.dumps({**SNAPSHOT, "flightDate": "2027-03-02"}).encode() + b"\n")
    assert sync.apply_manual_route("AQP", "LIM").uploaded["snapshots"] == 1
    content = path.read_bytes().replace(b'"price": 123', b'"price": 124', 1)
    path.write_bytes(content)
    with path.open("ab") as handle:
        handle.write(json.dumps({**SNAPSHOT, "flightDate": "2027-03-03"}).encode() + b"\n")
    assert sync.apply("incremental").uploaded["snapshots"] == 4
    assert any(row["cheapest_price"] == 124 for row in server.tables["fare_snapshots"].values())
