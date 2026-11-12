"""Map Supabase WebAuthn credentials to Better Auth's passkey fields.

This module never prints credential bytes or user rows. It requires an explicit
Neon branch name and an empty Better Auth schema.
"""

from __future__ import annotations

import base64
import json
import re
import sys
from collections.abc import Mapping
from pathlib import Path
from typing import Any
from uuid import UUID

_HEX = re.compile(rb"^[0-9a-fA-F]+$")
_BYTEA_PREFIX = bytes((92, 92, 120))


def decode_copy_bytea(value: bytes) -> bytes:
    """Decode Postgres's hex bytea representation inside text COPY output."""
    if not value.startswith(_BYTEA_PREFIX):
        raise ValueError("invalid COPY bytea")
    encoded = value[len(_BYTEA_PREFIX) :]
    if not encoded or len(encoded) % 2 or not _HEX.fullmatch(encoded):
        raise ValueError("invalid COPY bytea")
    return bytes.fromhex(encoded.decode("ascii"))


def _boolean(value: object) -> bool:
    value = _text(value)
    if value not in {"t", "f"}:
        raise ValueError("invalid COPY boolean")
    return value == "t"


def _text(value: object) -> str:
    if isinstance(value, bytes):
        return value.decode("utf-8")
    if isinstance(value, str):
        return value
    raise ValueError("invalid COPY text")


def read_copy_rows(path: Path, table: str):
    """Read one auth table without interpreting sensitive values or bytea."""
    if table not in {"users", "webauthn_credentials"}:
        raise ValueError("unexpected auth table")
    prefix = f'COPY "auth"."{table}" ('.encode()
    found = False
    with path.open("rb") as dump:
        for line in dump:
            if not line.startswith(prefix):
                continue
            if found:
                raise ValueError("duplicate auth COPY section")
            found = True
            header = line.rstrip(b"\r\n")
            suffix = b") FROM stdin;"
            if not header.endswith(suffix):
                raise ValueError("unexpected auth COPY header")
            fields = header[len(prefix) : -len(suffix)].split(b", ")
            columns = [field.strip(b'"').decode("ascii") for field in fields]
            if len(columns) != len(set(columns)):
                raise ValueError("duplicate auth COPY column")
            for row_line in dump:
                row_line = row_line.rstrip(b"\r\n")
                if row_line == b"\\.":
                    break
                values = row_line.split(b"\t")
                if len(values) != len(columns):
                    raise ValueError("invalid auth COPY row width")
                yield dict(zip(columns, (None if v == b"\\N" else v for v in values), strict=True))
            else:
                raise ValueError("unterminated auth COPY section")
    if not found:
        raise ValueError("auth COPY section missing")


def convert_user(row: Mapping[str, Any]) -> dict[str, Any]:
    """Keep the Supabase UUID as the Better Auth subject."""
    identifier = str(UUID(_text(row["id"])))
    email = _text(row["email"])
    if not email:
        raise ValueError("user email missing")
    return {
        "id": identifier,
        "name": email,
        "email": email,
        "emailVerified": row["email_confirmed_at"] is not None,
        "createdAt": _text(row["created_at"]),
        "updatedAt": _text(row["updated_at"]),
    }


def convert_passkey(row: Mapping[str, Any]) -> dict[str, Any]:
    """Preserve the credential's ID, COSE public key, and signature counter."""
    identifier = str(UUID(_text(row["id"])))
    user_id = str(UUID(_text(row["user_id"])))
    credential_id = decode_copy_bytea(row["credential_id"])
    public_key = decode_copy_bytea(row["public_key"])
    counter = int(_text(row["sign_count"]))
    if counter < 0:
        raise ValueError("negative passkey counter")
    eligible = _boolean(row["backup_eligible"])
    backed_up = _boolean(row["backed_up"])
    transports = json.loads(_text(row["transports"]))
    if not isinstance(transports, list) or any(
        not isinstance(item, str) or "," in item for item in transports
    ):
        raise ValueError("invalid passkey transports")
    return {
        "id": identifier,
        "userId": user_id,
        "credentialID": base64.urlsafe_b64encode(credential_id).decode("ascii").rstrip("="),
        "publicKey": base64.b64encode(public_key).decode("ascii"),
        "counter": counter,
        "deviceType": "multiDevice" if eligible else "singleDevice",
        "backedUp": backed_up,
        "transports": ",".join(transports),
        "name": _text(row["friendly_name"]) if row["friendly_name"] is not None else None,
        "createdAt": _text(row["created_at"]),
        "aaguid": _text(row["aaguid"]) if row["aaguid"] is not None else None,
    }


def import_auth(auth_dump: Path, env_file: Path, target_branch: str) -> None:
    """Transfer the existing owner and passkeys to an empty Auth schema."""
    import psycopg

    if target_branch not in {"migration-trial-20261111", "production"}:
        raise ValueError("unexpected target branch")
    if target_branch == "production" and env_file.name != ".env.local":
        raise ValueError("production environment file required")
    direct_url = None
    branch = None
    for line in env_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("DATABASE_URL_UNPOOLED="):
            direct_url = line.split("=", 1)[1].strip().strip('"')
        elif line.startswith("NEON_BRANCH="):
            branch = line.split("=", 1)[1].strip().strip('"')
    if branch != target_branch:
        raise ValueError("Neon branch does not match expected target")
    if not direct_url or not direct_url.startswith(("postgres://", "postgresql://")):
        raise ValueError("direct trial URL missing")
    users = [convert_user(row) for row in read_copy_rows(auth_dump, "users")]
    passkeys = [convert_passkey(row) for row in read_copy_rows(auth_dump, "webauthn_credentials")]
    if len(users) != 1 or len(passkeys) != 2:
        raise ValueError("unexpected auth row counts")
    user = users[0]
    if any(key["userId"] != user["id"] for key in passkeys):
        raise ValueError("passkey user mismatch")
    if (
        len({key["id"] for key in passkeys}) != 2
        or len({key["credentialID"] for key in passkeys}) != 2
    ):
        raise ValueError("duplicate passkey identifiers")

    with psycopg.connect(direct_url) as conn, conn.cursor() as cursor:
        cursor.execute("select owner_id::text from public.edicius_owners")
        owners = [row[0] for row in cursor.fetchall()]
        if owners != [user["id"]]:
            raise ValueError("public owner does not match auth user")
        cursor.execute('select count(*) from app_auth."user"')
        user_count = cursor.fetchone()
        if user_count is None or user_count[0] != 0:
            raise ValueError("auth user table is not empty")
        cursor.execute("select count(*) from app_auth.passkey")
        passkey_count = cursor.fetchone()
        if passkey_count is None or passkey_count[0] != 0:
            raise ValueError("auth passkey table is not empty")
        cursor.execute(
            'insert into app_auth."user" '
            '("id", "name", "email", "emailVerified", "createdAt", "updatedAt") '
            "values (%(id)s, %(name)s, %(email)s, %(emailVerified)s, "
            "%(createdAt)s, %(updatedAt)s)",
            user,
        )
        for key in passkeys:
            cursor.execute(
                "insert into app_auth.passkey "
                '("id", "name", "publicKey", "userId", "credentialID", '
                '"counter", "deviceType", "backedUp", "transports", '
                '"createdAt", "aaguid") '
                "values (%(id)s, %(name)s, %(publicKey)s, %(userId)s, "
                "%(credentialID)s, %(counter)s, %(deviceType)s, "
                "%(backedUp)s, %(transports)s, %(createdAt)s, %(aaguid)s)",
                key,
            )
        cursor.execute(
            'select "id", "userId", "credentialID", "publicKey", "counter" from app_auth.passkey'
        )
        actual = {row[0]: (row[1], row[2], row[3], row[4]) for row in cursor.fetchall()}
        expected = {
            key["id"]: (
                key["userId"],
                key["credentialID"],
                key["publicKey"],
                key["counter"],
            )
            for key in passkeys
        }
        if actual != expected:
            raise ValueError("passkey readback mismatch")
    print("auth_user_rows=1")
    print("passkey_rows=2")
    print("credential_bytes_and_counters_match=true")


if __name__ == "__main__":
    try:
        import_auth(Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3])
    except Exception as error:  # noqa: BLE001 - keep private auth rows out of errors
        print(f"import_error={type(error).__name__}")
        print(f"sqlstate={getattr(error, 'sqlstate', None) or 'none'}")
        raise SystemExit(1) from None
