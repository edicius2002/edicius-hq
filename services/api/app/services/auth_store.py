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
  conservative reading: with a single owner there is normally one live code,
  and the cost of being wrong is one re-run of the enrol command, against the
  alternative of an eight-character secret that can be guessed at forever.
"""

import base64
import hashlib
import hmac
import json
import os
import secrets
import tempfile
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
    encoded = _encode(credential_id)
    records = _read(CREDENTIALS_FILE)
    for record in records:
        if record["credential_id"] == encoded:
            record["sign_count"] = sign_count
            record["last_used_at"] = _iso(_now())
            _write(CREDENTIALS_FILE, records)
            return


def revoke_credential(short_id: str) -> bool:
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


def create_session() -> str:
    """Returns the plaintext token once. Only its digest reaches the disk."""
    token = secrets.token_urlsafe(32)
    now = _now()
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
    records = _live_sessions(_read(SESSIONS_FILE), now)
    candidate = _digest(token)
    for record in records:
        if _matches(candidate, record["token_hash"]):
            record["last_used_at"] = _iso(now)
            _write(SESSIONS_FILE, records)
            created_at = _parse(record["created_at"])
            return Session(
                created_at=created_at if created_at is not None else now,
                last_used_at=now,
            )
    # The expired records the read above dropped are worth persisting even on a
    # miss, so a file nobody signs into does not grow forever.
    _write(SESSIONS_FILE, records)
    return None


def revoke_session(token: str) -> None:
    candidate = _digest(token)
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
    """Returns the plaintext code once. Only its digest reaches the disk."""
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))
    now = _now()
    records = _live_codes(_read(CODES_FILE), now)
    records.append(
        {
            "code_hash": _digest(code),
            "expires_at": _iso(now + CODE_TTL),
            "failures": 0,
        }
    )
    _write(CODES_FILE, records)
    return code


def consume_code(code: str) -> bool:
    """
    `True` exactly once per code, and `False` for spent, expired and dead alike.

    A miss charges a failure to every live code — see the module docstring for
    why the count cannot be per code.
    """
    now = _now()
    records = _live_codes(_read(CODES_FILE), now)
    candidate = _digest(normalise_code(code))
    for index, record in enumerate(records):
        if _matches(candidate, record["code_hash"]):
            del records[index]
            _write(CODES_FILE, records)
            return True

    for record in records:
        record["failures"] = int(record.get("failures", 0)) + 1
    _write(CODES_FILE, _live_codes(records, now))
    return False
