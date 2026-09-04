"""
Credentials, sessions and enrolment codes on disk.

Shaped like `app/services/kv_store.py`: one directory under `LOCAL_DATA_DIR`,
JSON documents written beside-then-renamed, a missing file read as empty. What
it holds is different in kind from the key-value store, though, and two of the
differences are the reason this module exists rather than another allowlisted
kv key:

* **Nothing here is readable back as a secret.** A session token is stored as
  its SHA-256 digest and an enrolment code as its own; the plaintext is
  returned once, to the caller that created it, and never written down. Reading
  `sessions.json` off the disk therefore yields no session anyone can present.
  That matters because the file sits next to the data the session protects — an
  attacker who can read one can read the other, and the token being a hash is
  what stops the first from granting the second.

* **A failed enrolment attempt costs every live code.** `consume_code` is told
  a string and not which code it was aiming at, so there is no per-code counter
  to increment on a miss. Charging the failure to all of them is the
  conservative reading, and `issue_code` makes it cost nothing: there is
  exactly one live code at a time, so "all of them" is one, and the cost of
  being wrong is one re-issue against the alternative of an eight-character
  secret that can be guessed at forever.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import tempfile
import threading
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

from app.config import local_data_dir

# Thirty days of not being used, per the spec's sliding-session decision. Each
# resolve pushes the clock, so daily use never reaches this.
SESSION_TTL = timedelta(days=30)

# Long enough to walk a code from the PC to a phone, short enough that a code
# left in a scrollback is not a standing key.
CODE_TTL = timedelta(minutes=10)

# Five wrong guesses kill a code regardless of remaining time.
MAX_CODE_FAILURES = 5

# Crockford-style base32 minus the ambiguous pairs: no `0`/`O`, no `1`/`I`/`L`.
# Eight characters over thirty symbols is ~6.6e11 combinations for ten minutes.
CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
CODE_LENGTH = 8


@dataclass(frozen=True)
class Credential:
    """One enrolled passkey. `id` is the short handle the CLI revokes by."""

    id: str
    credential_id: bytes
    public_key: bytes
    sign_count: int
    label: str
    created_at: datetime
    last_used_at: datetime | None


@dataclass(frozen=True)
class Session:
    created_at: datetime
    last_used_at: datetime


def _now() -> datetime:
    """
    Module-level so tests can move time without waiting for it.

    Aware and UTC, because everything written here is compared against
    something read back from disk, and a naive datetime makes that comparison
    raise the first time the two disagree.
    """
    return datetime.now(UTC)


def auth_dir() -> Path:
    return local_data_dir() / "auth"


def ensure_auth_dir() -> None:
    auth_dir().mkdir(parents=True, exist_ok=True)


def _write_atomically(path: Path, text: str) -> None:
    """
    Beside, then flushed, then moved into place.

    `kv_store._write_atomically` carries the full argument for why; this file
    holds the sessions, where a half-written document signs the owner out of
    their own data.
    """
    descriptor, temporary_name = tempfile.mkstemp(dir=path.parent, prefix=path.name, suffix=".tmp")
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise


def _read(name: str) -> list[dict[str, Any]]:
    path = auth_dir() / name
    if not path.exists():
        return []
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        # A truncated document is not a reason to refuse every login forever;
        # the worst case is re-enrolling, which the owner can already do.
        return []
    return loaded if isinstance(loaded, list) else []


def _write(name: str, records: list[dict[str, Any]]) -> None:
    ensure_auth_dir()
    _write_atomically(auth_dir() / name, json.dumps(records, ensure_ascii=True, indent=2))


def _digest(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _matches(candidate_digest: str, stored_digest: str) -> bool:
    return hmac.compare_digest(candidate_digest, stored_digest)


def _encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii")


def _decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text.encode("ascii"))


def _iso(moment: datetime) -> str:
    return moment.isoformat()


def _parse(text: str | None) -> datetime | None:
    if not text:
        return None
    return datetime.fromisoformat(text)


# ------------------------------------------------------------ credentials ---

CREDENTIALS_FILE = "credentials.json"


def _as_credential(record: dict[str, Any]) -> Credential:
    created_at = _parse(record.get("created_at"))
    return Credential(
        id=record["id"],
        credential_id=_decode(record["credential_id"]),
        public_key=_decode(record["public_key"]),
        sign_count=int(record.get("sign_count", 0)),
        label=record.get("label", ""),
        created_at=created_at if created_at is not None else _now(),
        last_used_at=_parse(record.get("last_used_at")),
    )


def add_credential(credential_id: bytes, public_key: bytes, sign_count: int, label: str) -> str:
    """Stores one enrolled passkey and returns the short id the CLI revokes by."""
    with _FILE_LOCK:
        records = _read(CREDENTIALS_FILE)
        encoded = _encode(credential_id)
        # Re-enrolling the same authenticator replaces its record rather than
        # leaving two rows that answer to the same credential id.
        records = [record for record in records if record["credential_id"] != encoded]
        short_id = secrets.token_hex(4)
        records.append(
            {
                "id": short_id,
                "credential_id": encoded,
                "public_key": _encode(public_key),
                "sign_count": sign_count,
                "label": label,
                "created_at": _iso(_now()),
                "last_used_at": None,
            }
        )
        _write(CREDENTIALS_FILE, records)
        return short_id


def get_credential(credential_id: bytes) -> Credential | None:
    encoded = _encode(credential_id)
    for record in _read(CREDENTIALS_FILE):
        if record["credential_id"] == encoded:
            return _as_credential(record)
    return None


def list_credentials() -> list[Credential]:
    return [_as_credential(record) for record in _read(CREDENTIALS_FILE)]


def touch_credential(credential_id: bytes, sign_count: int) -> None:
    """The only audit trail this feature keeps: when each passkey last signed in."""
    with _FILE_LOCK:
        encoded = _encode(credential_id)
        records = _read(CREDENTIALS_FILE)
        for record in records:
            if record["credential_id"] == encoded:
                record["sign_count"] = sign_count
                record["last_used_at"] = _iso(_now())
                _write(CREDENTIALS_FILE, records)
                return


def revoke_credential(short_id: str) -> bool:
    with _FILE_LOCK:
        records = _read(CREDENTIALS_FILE)
        remaining = [record for record in records if record["id"] != short_id]
        if len(remaining) == len(records):
            return False
        _write(CREDENTIALS_FILE, remaining)
        return True


# --------------------------------------------------------------- sessions ---

SESSIONS_FILE = "sessions.json"


def _live_sessions(records: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    live = []
    for record in records:
        last_used = _parse(record.get("last_used_at"))
        if last_used is not None and now - last_used <= SESSION_TTL:
            live.append(record)
    return live


# Every request resolves a session, so this file is the busiest one the API
# writes. `_write_atomically` renames a temporary into place, which is atomic on
# POSIX and refuses on Windows while another thread holds the destination open —
# `PermissionError [WinError 5]`, measured at 31 failures in 60 concurrent
# resolutions. The lock makes read-modify-write one operation.
#
# Re-entrant, so a locked helper reached from a locked caller cannot
# deadlock. A thread lock is enough because `api.mjs` runs one uvicorn process and FastAPI
# dispatches sync handlers onto its threadpool. Run more than one worker and
# this stops being sufficient; the file would then need a real file lock.
_FILE_LOCK = threading.RLock()

# How stale the idle clock may get before a read pays for a write. The session
# still expires after `SESSION_TTL` of genuine disuse; this only says that a
# session used twice within the hour is not worth two disk writes.
SLIDE_AFTER = timedelta(hours=1)


def create_session() -> str:
    """Returns the plaintext token once. Only its digest reaches the disk."""
    token = secrets.token_urlsafe(32)
    now = _now()
    with _FILE_LOCK:
        records = _live_sessions(_read(SESSIONS_FILE), now)
        records.append(
            {
                "token_hash": _digest(token),
                "created_at": _iso(now),
                "last_used_at": _iso(now),
            }
        )
        _write(SESSIONS_FILE, records)
    return token


def resolve_session(token: str) -> Session | None:
    """`None` when absent or expired. On success the idle clock is pushed forward."""
    if not token:
        return None
    now = _now()
    candidate = _digest(token)
    with _FILE_LOCK:
        stored = _read(SESSIONS_FILE)
        records = _live_sessions(stored, now)
        for record in records:
            if _matches(candidate, record["token_hash"]):
                created_at = _parse(record["created_at"])
                last_used = _parse(record["last_used_at"])
                # Only pay for a write when the clock has drifted far enough to
                # be worth recording. Thirty sliding days do not notice an hour.
                if last_used is None or now - last_used >= SLIDE_AFTER:
                    record["last_used_at"] = _iso(now)
                    _write(SESSIONS_FILE, records)
                return Session(
                    created_at=created_at if created_at is not None else now,
                    last_used_at=now,
                )
        # A miss writes only when this read actually dropped something expired.
        # Rewriting on every miss would hand any stranger on the public internet
        # a disk write per request, which is a cost the owner pays and they do
        # not.
        if len(records) != len(stored):
            _write(SESSIONS_FILE, records)
    return None


def revoke_session(token: str) -> None:
    candidate = _digest(token)
    with _FILE_LOCK:
        records = _read(SESSIONS_FILE)
        _write(
            SESSIONS_FILE,
            [record for record in records if not _matches(candidate, record["token_hash"])],
        )


# -------------------------------------------------------- enrolment codes ---

CODES_FILE = "codes.json"


def normalise_code(raw: str) -> str:
    """
    The printed `K7M2-9QX4` and the typed `k7m29qx4` are the same secret.

    The separator and the case are presentation, so anything outside the
    alphabet is dropped rather than rejected — a code typed back with a space,
    a dash or in lower case is a code the owner got right.
    """
    upper = raw.strip().upper()
    return "".join(character for character in upper if character in CODE_ALPHABET)


def _live_codes(records: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    live = []
    for record in records:
        expires_at = _parse(record.get("expires_at"))
        if expires_at is None or expires_at <= now:
            continue
        if int(record.get("failures", 0)) >= MAX_CODE_FAILURES:
            continue
        live.append(record)
    return live


def issue_code() -> str:
    """
    Returns the plaintext code once. Only its digest reaches the disk.

    Issuing **replaces** whatever was live rather than joining it, so at most
    one code opens the door at any moment. Both callers are the same person —
    the CLI on the PC, the menu on a device already enrolled — and a second
    code is what that person asks for when the first one got away from them: a
    scrollback they walked away from, a menu they closed, a walk to the phone
    they abandoned. Leaving that one alive for the rest of its ten minutes
    would keep working a secret its owner has already given up on.

    It also turns the module docstring's assumption into an invariant. Charging
    a failed guess to every live code is defensible because there is normally
    one; with the replacement here there is always one, so a stranger guessing
    at the API can no longer cost the owner a *different* code they were in the
    middle of typing on another device.
    """
    with _FILE_LOCK:
        code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
        _write(
            CODES_FILE,
            [
                {
                    "code_hash": _digest(code),
                    "expires_at": _iso(_now() + CODE_TTL),
                    "failures": 0,
                }
            ],
        )
        return code


def _check_code(code: str, *, burn: bool) -> bool:
    """
    Shared by both code checks. A miss always charges a failure; a hit burns
    the code only when the caller says to.
    """
    with _FILE_LOCK:
        now = _now()
        records = _live_codes(_read(CODES_FILE), now)
        candidate = _digest(normalise_code(code))
        for index, record in enumerate(records):
            if _matches(candidate, record["code_hash"]):
                if burn:
                    del records[index]
                    _write(CODES_FILE, records)
                return True

        for record in records:
            record["failures"] = int(record.get("failures", 0)) + 1
        _write(CODES_FILE, _live_codes(records, now))
        return False


def authorise_code(code: str) -> bool:
    """
    Is this code good enough to start a registration ceremony? Does not burn it.

    Split from `consume_code` so that a ceremony the owner cancels — closing
    the Windows Hello dialog, changing their mind — does not cost them the
    code and a second trip to the PC. The guessing protection still lives here
    rather than at the burn, because this is the call an attacker can make
    repeatedly: a miss charges a failure exactly as a miss at `consume_code`
    does, and five of them kill the code either way.
    """
    return _check_code(code, burn=False)


def consume_code(code: str) -> bool:
    """
    `True` exactly once per code, and `False` for spent, expired and dead alike.

    A miss charges a failure to every live code — see the module docstring for
    why the count cannot be per code.
    """
    return _check_code(code, burn=True)


# -------------------------------------------------------------- challenges ---

CHALLENGES_FILE = "challenges.json"

# A ceremony that has not finished in ten minutes is one nobody is standing in
# front of. Matches the enrolment code's life so neither outlives the other.
CHALLENGE_TTL = timedelta(minutes=10)


def _live_challenges(records: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    live = []
    for record in records:
        expires_at = _parse(record.get("expires_at"))
        if expires_at is not None and expires_at > now:
            live.append(record)
    return live


def store_challenge(challenge: bytes, purpose: str) -> str:
    """
    Keeps a challenge between the `options` call that made it and the `verify`
    call that answers it, and returns the id the client quotes back.

    On disk rather than in a module-level dict, and the difference is not
    theoretical: a dict does not survive `--reload`, so the developer running
    the API with the reloader would have every ceremony fail with a working
    test suite explaining nothing.

    The id is a handle and not a secret. Holding it buys nothing on its own —
    answering a challenge still needs the private key the authenticator will
    not give up — so unlike the token and the code it is stored as it is.
    """
    with _FILE_LOCK:
        now = _now()
        challenge_id = secrets.token_urlsafe(16)
        records = _live_challenges(_read(CHALLENGES_FILE), now)
        records.append(
            {
                "id": challenge_id,
                "challenge": _encode(challenge),
                "purpose": purpose,
                "expires_at": _iso(now + CHALLENGE_TTL),
            }
        )
        _write(CHALLENGES_FILE, records)
        return challenge_id


def take_challenge(challenge_id: str, purpose: str) -> bytes | None:
    """
    Single use, and the purpose has to match.

    Both halves matter. Replay is what the challenge exists to stop, so one
    that has been answered is gone; and a registration challenge presented to
    the login route would otherwise let one ceremony's answer be spent on the
    other.
    """
    with _FILE_LOCK:
        now = _now()
        records = _live_challenges(_read(CHALLENGES_FILE), now)
        for index, record in enumerate(records):
            if record["id"] == challenge_id and record["purpose"] == purpose:
                del records[index]
                _write(CHALLENGES_FILE, records)
                return _decode(record["challenge"])
        _write(CHALLENGES_FILE, records)
        return None
