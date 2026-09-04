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


def test_code_is_accepted_with_or_without_the_printed_separator(tmp_local_data):
    """The PC prints `K7M2-9QX4`; the phone may be typed anything equivalent."""
    code = auth_store.issue_code()
    formatted = f"{code[:4]}-{code[4:]}"
    assert auth_store.consume_code(formatted.lower()) is True


def test_authorise_code_does_not_burn_it(tmp_local_data):
    code = auth_store.issue_code()
    assert auth_store.authorise_code(code) is True
    assert auth_store.authorise_code(code) is True
    assert auth_store.consume_code(code) is True
    assert auth_store.authorise_code(code) is False


def test_authorise_still_charges_a_failed_guess(tmp_local_data):
    code = auth_store.issue_code()
    for _ in range(5):
        assert auth_store.authorise_code("WRONGCOD") is False
    assert auth_store.authorise_code(code) is False


def test_a_challenge_is_single_use_and_bound_to_its_purpose(tmp_local_data):
    challenge_id = auth_store.store_challenge(b"a-challenge", "registration")
    assert auth_store.take_challenge(challenge_id, "authentication") is None
    assert auth_store.take_challenge(challenge_id, "registration") == b"a-challenge"
    assert auth_store.take_challenge(challenge_id, "registration") is None


def test_concurrent_resolution_does_not_fail(tmp_local_data):
    """
    Every request resolves a session, and the page opens ten at once.

    The store writes beside-then-renames, which is atomic on POSIX and is not
    on Windows: `os.replace` refuses while another thread holds the
    destination open, with `PermissionError [WinError 5]`. Sliding the clock on
    every single request made that collision the common case rather than a
    rare one — measured at 31 failures in 60 concurrent calls before the lock.
    """
    import concurrent.futures

    token = auth_store.create_session()

    def resolve(_: int) -> str | None:
        try:
            auth_store.resolve_session(token)
        except BaseException as error:  # noqa: BLE001 - the point is that none escape
            return repr(error)
        return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as pool:
        failures = [outcome for outcome in pool.map(resolve, range(60)) if outcome]

    assert failures == []


def test_a_miss_does_not_write(tmp_local_data):
    """
    An unauthenticated request must not cost a disk write.

    Once the API is public every stranger's request arrives here, and a store
    that rewrites its file on each miss turns that into unbounded write load
    against the owner's own disk.
    """
    auth_store.create_session()
    path = auth_store.auth_dir() / "sessions.json"
    before = path.stat().st_mtime_ns

    assert auth_store.resolve_session("not-a-real-token") is None

    assert path.stat().st_mtime_ns == before
