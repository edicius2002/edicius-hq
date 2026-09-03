"""
The auth store's load-bearing promises, in the order the spec argues for them.

Every test here is about something that has to stay true for the gate to mean
anything: a stolen session file yields no live session, a session that is used
keeps living, a code is worth one enrolment, and a code under attack dies
before it can be guessed.
"""

from datetime import UTC, datetime, timedelta

import pytest

from app.services import auth_store


def _now() -> datetime:
    return datetime.now(UTC)


@pytest.fixture
def tmp_local_data(tmp_path, monkeypatch):
    """
    `conftest.py` already redirects `LOCAL_DATA_DIR` for every test; this names
    the dependency at the point the assertions rely on it, so a reader does not
    have to know about the autouse fixture to trust the file paths below.
    """
    directory = tmp_path / "auth-local-data"
    monkeypatch.setenv("LOCAL_DATA_DIR", str(directory))
    return directory


def test_session_token_is_not_stored_in_plaintext(tmp_local_data):
    token = auth_store.create_session()
    stored = (auth_store.auth_dir() / "sessions.json").read_text(encoding="utf-8")
    assert token not in stored


def test_session_slides_on_use(tmp_local_data, monkeypatch):
    token = auth_store.create_session()
    # 29 days on: still alive, and the clock is pushed forward
    at_29 = _now() + timedelta(days=29)
    monkeypatch.setattr(auth_store, "_now", lambda: at_29)
    assert auth_store.resolve_session(token) is not None
    # 29 more days after that use: still alive, because the clock slid
    monkeypatch.setattr(auth_store, "_now", lambda: at_29 + timedelta(days=29))
    assert auth_store.resolve_session(token) is not None


def test_session_expires_after_thirty_idle_days(tmp_local_data, monkeypatch):
    token = auth_store.create_session()
    at_31 = _now() + timedelta(days=31)
    monkeypatch.setattr(auth_store, "_now", lambda: at_31)
    assert auth_store.resolve_session(token) is None


def test_revoked_session_stops_resolving(tmp_local_data):
    token = auth_store.create_session()
    assert auth_store.resolve_session(token) is not None
    auth_store.revoke_session(token)
    assert auth_store.resolve_session(token) is None


def test_code_is_single_use(tmp_local_data):
    code = auth_store.issue_code()
    assert auth_store.consume_code(code) is True
    assert auth_store.consume_code(code) is False


def test_code_expires_after_ten_minutes(tmp_local_data, monkeypatch):
    code = auth_store.issue_code()
    later = _now() + timedelta(minutes=11)
    monkeypatch.setattr(auth_store, "_now", lambda: later)
    assert auth_store.consume_code(code) is False


def test_code_dies_after_five_failures(tmp_local_data):
    code = auth_store.issue_code()
    for _ in range(5):
        assert auth_store.consume_code("WRONGCOD") is False
    assert auth_store.consume_code(code) is False, "the real code must be dead too"


def test_code_alphabet_has_no_ambiguous_characters(tmp_local_data):
    codes = {auth_store.issue_code() for _ in range(200)}
    assert not any(set(c) & set("01OIL") for c in codes)
    assert all(len(c) == 8 for c in codes)


def test_credentials_round_trip(tmp_local_data):
    short_id = auth_store.add_credential(b"cred-1", b"public-key-1", 4, "Windows Hello")
    stored = auth_store.get_credential(b"cred-1")
    assert stored is not None
    assert stored.public_key == b"public-key-1"
    assert stored.sign_count == 4
    assert [c.id for c in auth_store.list_credentials()] == [short_id]


def test_touch_credential_records_the_new_sign_count(tmp_local_data):
    auth_store.add_credential(b"cred-1", b"public-key-1", 4, "Windows Hello")
    auth_store.touch_credential(b"cred-1", 9)
    stored = auth_store.get_credential(b"cred-1")
    assert stored is not None
    assert stored.sign_count == 9
    assert stored.last_used_at is not None


def test_revoke_credential_reports_whether_it_removed_anything(tmp_local_data):
    short_id = auth_store.add_credential(b"cred-1", b"public-key-1", 0, "Phone")
    assert auth_store.revoke_credential(short_id) is True
    assert auth_store.revoke_credential(short_id) is False
    assert auth_store.get_credential(b"cred-1") is None
