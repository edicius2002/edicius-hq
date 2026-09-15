"""Synchronization contracts exercised with real files and the safe HTTP boundary."""

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

import httpx
import pytest

from app.services.airfare_supabase import SupabaseAirfare
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
        if table == "read_airfare_history":
            return httpx.Response(200, json=self.history)
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


@pytest.fixture
def remote():
    destination = Destination()
    client = SupabaseAirfare(
        "https://testproject.supabase.co",
        "sb_secret_test",
        transport=httpx.MockTransport(destination.handle),
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
    assert "duration_seconds" in data and "project_ref" in data and "source_root" in data
    assert not (source / "fares/sync").exists()
    mixed = subprocess.run(
        [sys.executable, str(script), "--dry-run", "--apply"], capture_output=True, check=False
    )
    assert mixed.returncode == 2


def test_compare_reads_uses_real_local_readers_and_reports_differences(source, remote):
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
    result = module.compare_reads(source, client)
    assert result["matches"] and result["routes"] == 1
    assert all(item["local_digest"] == item["remote_digest"] for item in result["comparisons"])
    server.calendar["horizon"]["prices"][1]["price"] = "90"
    assert module.compare_reads(source, client)["matches"]
    server.calendar["horizon"]["prices"][0]["price"] = 0
    result = module.compare_reads(source, client)
    assert not result["matches"] and "AQP-LIM:calendar" in result["mismatches"]


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


def test_successful_import_run_records_destination_route_manifest(source, remote):
    server, client = remote
    assert AirfareSync(source, client).apply("full").status == "complete"
    run = next(iter(server.tables["airfare_import_runs"].values()))
    assert run["destination_manifest"]
    assert run["destination_manifest"][0]["dataset"] == "baseline"
    assert "payload" not in json.dumps(run)


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
