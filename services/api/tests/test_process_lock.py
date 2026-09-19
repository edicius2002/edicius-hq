from __future__ import annotations

import pytest

from app.services import process_lock


def test_named_process_lock_rejects_a_concurrent_owner(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(process_lock, "local_data_dir", lambda: tmp_path)

    with (
        process_lock.exclusive_process_lock("market"),
        pytest.raises(process_lock.ProcessLockUnavailable),
        process_lock.exclusive_process_lock("market"),
    ):
        pass


def test_different_collectors_have_independent_process_locks(monkeypatch, tmp_path) -> None:
    monkeypatch.setattr(process_lock, "local_data_dir", lambda: tmp_path)

    with (
        process_lock.exclusive_process_lock("market"),
        process_lock.exclusive_process_lock("tweets"),
    ):
        assert (tmp_path / "locks" / "market.lock").is_file()
        assert (tmp_path / "locks" / "tweets.lock").is_file()
