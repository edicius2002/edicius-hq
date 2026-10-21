"""Baseline acknowledgements survive retries without trusting file positions."""

import json
import os
import stat

import pytest

from app.services import airfare_baseline_ack
from app.services.airfare_baseline_ack import BaselineAcknowledgements

FIRST = ("2027-03-01", "2026-10-20")
SECOND = ("2027-03-02", "2026-10-20")
OLD = "a" * 64
NEW = "b" * 64


def test_a_missing_checkpoint_needs_every_current_key(tmp_path):
    checkpoint = BaselineAcknowledgements(tmp_path / "route.json", replica_id="replica-one")

    assert checkpoint.needed({FIRST: OLD, SECOND: NEW}) == {FIRST, SECOND}
    assert not list(tmp_path.iterdir())


def test_confirmed_values_survive_restart_and_changed_values_are_needed(tmp_path):
    path = tmp_path / "route.json"
    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one")
    checkpoint.pending([FIRST])
    checkpoint.confirm({FIRST: OLD})

    restarted = BaselineAcknowledgements(path, replica_id="replica-one")
    assert restarted.needed({FIRST: OLD}) == set()
    assert restarted.needed({FIRST: NEW, SECOND: OLD}) == {FIRST, SECOND}


def test_changing_remote_identity_requires_replay(tmp_path):
    path = tmp_path / "route.json"
    original = BaselineAcknowledgements(path, replica_id="replica-one")
    original.pending([FIRST])
    original.confirm({FIRST: OLD})

    replacement = BaselineAcknowledgements(path, replica_id="replica-two")
    assert replacement.needed({FIRST: OLD}) == {FIRST}
    replacement.pending([FIRST])
    replacement.confirm({FIRST: NEW})
    assert BaselineAcknowledgements(path, replica_id="replica-two").needed({FIRST: NEW}) == set()
    assert BaselineAcknowledgements(path, replica_id="replica-one").needed({FIRST: OLD}) == {FIRST}


def test_remote_identity_is_not_persisted_in_plain_text(tmp_path):
    path = tmp_path / "route.json"
    identity = "https://a-project.example.test"
    checkpoint = BaselineAcknowledgements(path, replica_id=identity)
    checkpoint.pending([FIRST])
    checkpoint.confirm({FIRST: OLD})

    assert identity not in path.read_text(encoding="utf-8")
    assert BaselineAcknowledgements(path, replica_id=identity).needed({FIRST: OLD}) == set()


def test_an_old_checkpoint_without_remote_identity_confirms_nothing(tmp_path):
    path = tmp_path / "route.json"
    path.write_text(json.dumps({"version": 1, "acknowledged": [[*FIRST, OLD]]}), encoding="utf-8")

    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one")

    assert checkpoint.needed({FIRST: OLD}) == {FIRST}


def test_invalidating_one_key_keeps_other_confirmed_keys(tmp_path):
    path = tmp_path / "route.json"
    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one")
    checkpoint.pending([FIRST, SECOND])
    checkpoint.confirm({FIRST: OLD, SECOND: NEW})

    checkpoint.pending([FIRST])

    assert BaselineAcknowledgements(path, replica_id="replica-one").needed(
        {FIRST: OLD, SECOND: NEW}
    ) == {FIRST}


def test_a_lost_response_then_source_reversion_still_needs_the_original_value(tmp_path):
    path = tmp_path / "route.json"
    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one")
    checkpoint.pending([FIRST])
    checkpoint.confirm({FIRST: OLD})

    # B can commit remotely and lose its response. The next scan may already
    # contain A again, so keeping A's previous ACK would skip a required write.
    checkpoint.pending([FIRST])

    restarted = BaselineAcknowledgements(path, replica_id="replica-one")
    assert restarted.needed({FIRST: OLD}) == {FIRST}
    restarted.confirm({FIRST: OLD})
    assert BaselineAcknowledgements(path, replica_id="replica-one").needed({FIRST: OLD}) == set()


def test_a_failed_batch_keeps_only_unconfirmed_keys_pending_after_restart(tmp_path):
    path = tmp_path / "route.json"
    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one")
    checkpoint.pending([FIRST, SECOND])
    checkpoint.confirm({FIRST: OLD, SECOND: OLD})
    checkpoint.pending([FIRST])
    checkpoint.confirm({FIRST: NEW})
    checkpoint.pending([SECOND])
    # The batch carrying SECOND fails, so it receives no confirmation.

    restarted = BaselineAcknowledgements(path, replica_id="replica-one")
    assert restarted.needed({FIRST: NEW, SECOND: NEW}) == {SECOND}
    assert restarted.needed({FIRST: NEW, SECOND: OLD}) == {SECOND}
    restarted.pending([SECOND])
    restarted.confirm({SECOND: NEW})
    assert (
        BaselineAcknowledgements(path, replica_id="replica-one").needed({FIRST: NEW, SECOND: NEW})
        == set()
    )


@pytest.mark.parametrize(
    "content",
    [
        "{truncated",
        "[]",
        '{"version": 3, "acknowledged": []}',
        '{"version": true, "acknowledged": []}',
        json.dumps({"version": 1.0, "acknowledged": [[*FIRST, OLD]]}),
        '{"version": 1, "acknowledged": {}}',
        json.dumps({"version": 1, "acknowledged": [[*FIRST, OLD], ["incomplete"]]}),
        json.dumps({"version": 1, "acknowledged": [[*FIRST, OLD], [*FIRST, NEW]]}),
        json.dumps({"version": 1, "acknowledged": [[*FIRST, "invalid-id"]]}),
    ],
)
def test_an_invalid_checkpoint_confirms_nothing(tmp_path, content):
    path = tmp_path / "route.json"
    seeded = BaselineAcknowledgements(path, replica_id="replica-one")
    seeded.pending([FIRST])
    seeded.confirm({FIRST: OLD})
    try:
        invalid = json.loads(content)
    except ValueError:
        pass
    else:
        if isinstance(invalid, dict):
            invalid["replica_id"] = json.loads(path.read_text(encoding="utf-8"))["replica_id"]
            content = json.dumps(invalid)
    path.write_text(content, encoding="utf-8")

    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one")

    assert checkpoint.needed({FIRST: OLD, SECOND: NEW}) == {FIRST, SECOND}


@pytest.mark.parametrize("operation", ["pending", "confirm"])
def test_a_failed_write_keeps_the_last_durable_state_and_removes_temporary_files(
    tmp_path, monkeypatch, operation
):
    path = tmp_path / "route.json"
    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one")
    checkpoint.pending([FIRST])
    checkpoint.confirm({FIRST: OLD})
    if operation == "confirm":
        checkpoint.pending([FIRST])
    before = path.read_bytes()

    def fail_write(value, handle, **kwargs):
        handle.write('{"version":')
        raise OSError("simulated full disk")

    monkeypatch.setattr(airfare_baseline_ack.json, "dump", fail_write)
    with pytest.raises(OSError, match="simulated full disk"):
        if operation == "pending":
            checkpoint.pending([FIRST])
        else:
            checkpoint.confirm({FIRST: NEW})

    assert path.read_bytes() == before
    assert list(tmp_path.iterdir()) == [path]
    expected = set() if operation == "pending" else {FIRST}
    assert checkpoint.needed({FIRST: OLD}) == expected
    assert BaselineAcknowledgements(path, replica_id="replica-one").needed({FIRST: OLD}) == expected
    assert checkpoint.needed({FIRST: NEW}) == {FIRST}


def test_a_failed_replace_does_not_invalidate_acknowledgements_in_memory(tmp_path, monkeypatch):
    path = tmp_path / "route.json"
    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one")
    checkpoint.pending([FIRST])
    checkpoint.confirm({FIRST: OLD})
    before = path.read_bytes()

    def fail_replace(source, destination):
        raise OSError("simulated replace failure")

    monkeypatch.setattr(airfare_baseline_ack.os, "replace", fail_replace)
    with pytest.raises(OSError, match="simulated replace failure"):
        checkpoint.pending([FIRST])

    assert path.read_bytes() == before
    assert list(tmp_path.iterdir()) == [path]
    assert checkpoint.needed({FIRST: OLD}) == set()
    assert BaselineAcknowledgements(path, replica_id="replica-one").needed({FIRST: OLD}) == set()


def test_pending_flushes_the_file_before_replace_and_the_directory_afterwards(
    tmp_path, monkeypatch
):
    path = tmp_path / "route.json"
    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one")
    events = []
    fsync = os.fsync
    replace = os.replace

    def record_fsync(descriptor):
        events.append("directory" if stat.S_ISDIR(os.fstat(descriptor).st_mode) else "file")
        fsync(descriptor)

    def record_replace(source, destination):
        events.append("replace")
        replace(source, destination)

    monkeypatch.setattr(airfare_baseline_ack.os, "fsync", record_fsync)
    monkeypatch.setattr(airfare_baseline_ack.os, "replace", record_replace)

    checkpoint.pending([FIRST])

    assert events == (["file", "replace"] if os.name == "nt" else ["file", "replace", "directory"])
    assert BaselineAcknowledgements(path, replica_id="replica-one").needed({FIRST: OLD}) == {FIRST}


def test_changed_writer_cursor_invalidates_otherwise_matching_acknowledgements(tmp_path):
    path = tmp_path / "route.json"
    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one", writer_cursor=OLD)
    checkpoint.pending([FIRST])
    checkpoint.confirm({FIRST: OLD}, writer_cursor=OLD)

    assert (
        BaselineAcknowledgements(path, replica_id="replica-one", writer_cursor=OLD).needed(
            {FIRST: OLD}
        )
        == set()
    )
    assert BaselineAcknowledgements(path, replica_id="replica-one", writer_cursor=NEW).needed(
        {FIRST: OLD}
    ) == {FIRST}


def test_confirmation_binds_records_and_new_writer_cursor_atomically(tmp_path, monkeypatch):
    path = tmp_path / "route.json"
    checkpoint = BaselineAcknowledgements(path, replica_id="replica-one", writer_cursor=OLD)
    checkpoint.pending([FIRST])

    def fail_replace(source, destination):
        raise OSError("simulated crash before checkpoint replacement")

    with monkeypatch.context() as patch:
        patch.setattr(airfare_baseline_ack.os, "replace", fail_replace)
        with pytest.raises(OSError, match="simulated crash"):
            checkpoint.confirm({FIRST: OLD}, writer_cursor=NEW)

    assert BaselineAcknowledgements(path, replica_id="replica-one", writer_cursor=NEW).needed(
        {FIRST: OLD}
    ) == {FIRST}
    checkpoint.confirm({FIRST: OLD}, writer_cursor=NEW)
    assert (
        BaselineAcknowledgements(path, replica_id="replica-one", writer_cursor=NEW).needed(
            {FIRST: OLD}
        )
        == set()
    )
