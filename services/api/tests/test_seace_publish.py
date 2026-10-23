"""A network failure leaves the SEACE sync checkpoint unadvanced."""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "seace"))

from incremental import rows_for_year
from publish import publish_updates, stable_key


class FakeCloud:
    def __init__(self, fail_on_batch=None):
        self.batches = []
        self.states = []
        self.fail_on_batch = fail_on_batch

    def upsert_seace_records(self, rows):
        if len(self.batches) == self.fail_on_batch:
            raise RuntimeError("network lost")
        self.batches.append(rows)
        return len(rows)

    def upsert_seace_sync_state(self, row):
        self.states.append(row)


def test_uploads_in_batches_then_advances_checkpoint():
    cloud = FakeCloud()
    rows = [
        {"id": index, "published": "22/10/2026 08:00", "code": f"CM-{index}"}
        for index in range(205)
    ]
    count = publish_updates(
        cloud, "Arequipa", 2026, "notices", rows, "2026-10-22T09:00:00-05:00", 7307
    )
    assert count == 205
    assert [len(batch) for batch in cloud.batches] == [100, 100, 5]
    assert cloud.states == [
        {
            "region": "Arequipa",
            "year": 2026,
            "kind": "notices",
            "fetched_at": "2026-10-22T14:00:00+00:00",
            "record_count": 7307,
        }
    ]
    assert cloud.batches[0][0]["published_at"] == "2026-10-22T13:00:00+00:00"


def test_failed_batch_does_not_advance_checkpoint_and_retry_is_stable():
    rows = [{"id": index} for index in range(101)]
    cloud = FakeCloud(fail_on_batch=1)
    with pytest.raises(RuntimeError, match="network lost"):
        publish_updates(
            cloud, "Arequipa", 2026, "contracts", rows, "2026-10-22T09:00:00-05:00", 101
        )
    assert cloud.states == []
    retry = FakeCloud()
    publish_updates(retry, "Arequipa", 2026, "contracts", rows, "2026-10-22T09:00:00-05:00", 101)
    assert retry.states[0]["record_count"] == 101
    assert stable_key(rows[0], "contracts") == retry.batches[0][0]["record_key"]


def test_process_key_includes_region_publication_and_entity():
    first = {"region": "Arequipa", "code": "AS-1", "published": "01/10/2026", "entity": "Entidad A"}
    second = {**first, "entity": "Entidad B"}
    assert stable_key(first, "processes") != stable_key(second, "processes")


def test_new_year_refresh_does_not_reconcile_previous_year_rows():
    snapshot = {
        "records": [
            {"region": "Arequipa", "published": "31/12/2026", "state": "Vigente"},
            {"region": "Arequipa", "published": "01/01/2027", "state": "Vigente"},
            {"region": "Lima", "published": "01/01/2027", "state": "Vigente"},
        ]
    }
    assert rows_for_year(snapshot, "Arequipa", 2027) == [snapshot["records"][1]]
