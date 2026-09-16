"""The route history read cache and its consistency boundaries."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from conftest import snapshot
from fastapi import HTTPException

from app.routers import fares as fares_router
from app.services import fare_history
from app.services.airfare_data import AirfareData
from app.services.fare_calendar import FareCalendar
from app.services.fare_history import FareHistory, FareHistoryReadError


def test_unchanged_route_is_not_decoded_again(monkeypatch, tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))

    decoded = 0
    real_decode = fare_history._snapshot_from

    def counting_decode(line: str):
        nonlocal decoded
        decoded += 1
        return real_decode(line)

    monkeypatch.setattr(fare_history, "_snapshot_from", counting_decode)

    assert len(history.read("LIM", "SCL")) == 1
    assert len(history.read("LIM", "SCL")) == 1
    assert decoded == 1


def test_own_append_invalidates_even_before_a_signature_can_change(monkeypatch, tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    fixed = fare_history._FileSignature(1, 2, 3, 4)
    monkeypatch.setattr(fare_history._FileSignature, "read", lambda path: fixed)
    assert len(history.read("LIM", "SCL")) == 1

    history.append(snapshot("2026-08-18T12:00:00+00:00", prices=[139.0]))

    assert [item.captured_at[:10] for item in history.read("LIM", "SCL")] == [
        "2026-08-17",
        "2026-08-18",
    ]


def test_external_append_is_discovered_without_a_ttl(tmp_path):
    reader = FareHistory(tmp_path)
    writer = FareHistory(tmp_path)
    writer.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    assert len(reader.read("LIM", "SCL")) == 1

    writer.append(snapshot("2026-08-18T12:00:00+00:00", prices=[139.0]))

    assert len(reader.read("LIM", "SCL")) == 2


def test_missing_route_can_appear_after_an_empty_read(tmp_path):
    reader = FareHistory(tmp_path)
    assert reader.read("LIM", "SCL") == []

    FareHistory(tmp_path).append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))

    assert len(reader.read("LIM", "SCL")) == 1


def test_replacement_and_truncation_are_discovered(tmp_path):
    reader = FareHistory(tmp_path)
    writer = FareHistory(tmp_path)
    writer.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    assert reader.read("LIM", "SCL")[0].offers[0].price == 125.0

    replacement_dir = tmp_path / "replacement"
    FareHistory(replacement_dir).append(snapshot("2026-08-17T12:00:00+00:00", prices=[126.0]))
    (replacement_dir / "LIM-SCL.jsonl").replace(tmp_path / "LIM-SCL.jsonl")
    assert reader.read("LIM", "SCL")[0].offers[0].price == 126.0

    (tmp_path / "LIM-SCL.jsonl").write_text("", encoding="utf-8")
    assert reader.read("LIM", "SCL") == []


def test_a_file_that_changes_while_decoding_is_retried(monkeypatch, tmp_path):
    reader = FareHistory(tmp_path)
    writer = FareHistory(tmp_path)
    writer.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    real_decode = fare_history._snapshot_from
    changed = False
    decoded = 0

    def changing_decode(line: str):
        nonlocal changed, decoded
        decoded += 1
        result = real_decode(line)
        if not changed:
            changed = True
            writer.append(snapshot("2026-08-18T12:00:00+00:00", prices=[139.0]))
        return result

    monkeypatch.setattr(fare_history, "_snapshot_from", changing_decode)

    assert len(reader.read("LIM", "SCL")) == 2
    assert len(reader.read("LIM", "SCL")) == 2
    assert decoded >= 3


def test_transient_read_error_is_raised_and_a_later_read_recovers(monkeypatch, tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    target = tmp_path / "LIM-SCL.jsonl"
    real_open = Path.open
    fail = True

    def transient_open(path: Path, *args, **kwargs):
        nonlocal fail
        if path == target and fail:
            fail = False
            raise PermissionError("temporarily locked")
        return real_open(path, *args, **kwargs)

    monkeypatch.setattr(Path, "open", transient_open)

    with pytest.raises(PermissionError, match="temporarily locked"):
        history.read("LIM", "SCL")
    assert len(history.read("LIM", "SCL")) == 1


def test_concurrent_reads_build_one_cached_value(monkeypatch, tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    real_decode = fare_history._snapshot_from
    decoded = 0
    decoding = threading.Lock()

    def slow_decode(line: str):
        nonlocal decoded
        with decoding:
            decoded += 1
        time.sleep(0.05)
        return real_decode(line)

    monkeypatch.setattr(fare_history, "_snapshot_from", slow_decode)
    gate = threading.Barrier(2)

    def read():
        gate.wait()
        return history.read("LIM", "SCL")

    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: read(), range(2)))

    assert [len(result) for result in results] == [1, 1]
    assert decoded == 1


def test_entry_limit_evicts_the_least_recent_route(monkeypatch, tmp_path):
    history = FareHistory(tmp_path, cache_max_entries=1)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[600.0], destination="MAD"))
    real_decode = fare_history._snapshot_from
    decoded = 0

    def counting_decode(line: str):
        nonlocal decoded
        decoded += 1
        return real_decode(line)

    monkeypatch.setattr(fare_history, "_snapshot_from", counting_decode)

    history.read("LIM", "SCL")
    history.read("LIM", "MAD")
    history.read("LIM", "SCL")
    assert decoded == 3


def test_byte_limit_does_not_keep_an_oversized_route(monkeypatch, tmp_path):
    history = FareHistory(tmp_path, cache_max_bytes=1)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    real_decode = fare_history._snapshot_from
    decoded = 0

    def counting_decode(line: str):
        nonlocal decoded
        decoded += 1
        return real_decode(line)

    monkeypatch.setattr(fare_history, "_snapshot_from", counting_decode)

    history.read("LIM", "SCL")
    history.read("LIM", "SCL")
    assert decoded == 2


def test_callers_cannot_mutate_cached_offers(tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))

    first = history.read("LIM", "SCL")
    first[0].offers.clear()

    assert [offer.price for offer in history.read("LIM", "SCL")[0].offers] == [125.0]


def test_filtered_read_does_not_narrow_the_cached_route(monkeypatch, tmp_path):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    history.append(snapshot("2026-08-18T12:00:00+00:00", prices=[139.0]))
    real_decode = fare_history._snapshot_from
    decoded = 0

    def counting_decode(line: str):
        nonlocal decoded
        decoded += 1
        return real_decode(line)

    monkeypatch.setattr(fare_history, "_snapshot_from", counting_decode)

    assert len(history.read("LIM", "SCL", since="2026-08-18")) == 1
    assert len(history.read("LIM", "SCL")) == 2
    assert decoded == 2


def test_empty_until_matches_absent_until_on_a_cache_hit_and_bounds_still_filter(
    monkeypatch, tmp_path
):
    history = FareHistory(tmp_path)
    for day in ("16", "17", "18"):
        history.append(snapshot(f"2026-08-{day}T12:00:00+00:00", prices=[125.0]))
    real_decode = fare_history._snapshot_from
    decoded = 0

    def counting_decode(line: str):
        nonlocal decoded
        decoded += 1
        return real_decode(line)

    monkeypatch.setattr(fare_history, "_snapshot_from", counting_decode)

    absent_until = history.read("LIM", "SCL", until=None)
    empty_until = history.read("LIM", "SCL", until="")
    empty_since = history.read("LIM", "SCL", since="")
    bounded = history.read(
        "LIM",
        "SCL",
        since="2026-08-17",
        until="2026-08-17T23",
    )

    assert [item.captured_at[:10] for item in absent_until] == [
        "2026-08-16",
        "2026-08-17",
        "2026-08-18",
    ]
    assert empty_until == absent_until
    assert empty_since == absent_until
    assert [item.captured_at[:10] for item in bounded] == ["2026-08-17"]
    assert decoded == 3


def test_fully_corrupt_archive_is_not_cached_as_an_empty_success(monkeypatch, tmp_path):
    (tmp_path / "LIM-SCL.jsonl").write_text('{"broken": true}\n', encoding="utf-8")
    history = FareHistory(tmp_path)
    real_decode = fare_history._snapshot_from
    decoded = 0

    def counting_decode(line: str):
        nonlocal decoded
        decoded += 1
        return real_decode(line)

    monkeypatch.setattr(fare_history, "_snapshot_from", counting_decode)

    assert history.read("LIM", "SCL") == []
    assert history.read("LIM", "SCL") == []
    assert decoded == 2


def test_continuously_changing_archive_raises_instead_of_caching_a_partial_read(
    monkeypatch, tmp_path
):
    history = FareHistory(tmp_path)
    history.append(snapshot("2026-08-17T12:00:00+00:00", prices=[125.0]))
    real_signature = fare_history._FileSignature.read
    calls = 0

    def moving_signature(path: Path):
        nonlocal calls
        signature = real_signature(path)
        calls += 1
        return fare_history._FileSignature(
            signature.device,
            signature.inode,
            signature.size + calls,
            signature.mtime_ns,
        )

    monkeypatch.setattr(fare_history._FileSignature, "read", moving_signature)

    with pytest.raises(FareHistoryReadError, match="changed during 3 reads"):
        history.read("LIM", "SCL")


def test_history_endpoint_translates_archive_io_failure_to_503(monkeypatch, tmp_path):
    class UnreadableHistory:
        def read(self, *args, **kwargs):
            raise PermissionError("archive is locked")

    monkeypatch.setattr(
        fares_router,
        "AIRFARE_DATA",
        AirfareData(UnreadableHistory(), FareCalendar(tmp_path / "calendar"), source_root=tmp_path),
    )

    with pytest.raises(HTTPException) as raised:
        fares_router.get_history(
            "LIM",
            "SCL",
            departure=None,
            since=None,
            until=None,
        )

    assert raised.value.status_code == 503
