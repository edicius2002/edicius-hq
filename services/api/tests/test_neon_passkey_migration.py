"""Credential migration must preserve the bytes WebAuthn verifies."""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts"))
from neon_import_passkeys import (
    convert_passkey,
    convert_user,
    decode_copy_bytea,
    read_copy_rows,
)


def test_copy_bytea_decodes_supabase_credential_bytes():
    assert decode_copy_bytea(b"\\\\x0102ff") == bytes.fromhex("0102ff")
    for malformed in (b"plain", b"\\\\x0", b"\\\\xzz"):
        with pytest.raises(ValueError):
            decode_copy_bytea(malformed)


def test_passkey_mapping_preserves_public_key_credential_id_and_counter():
    credential = bytes.fromhex("0102ff")
    public_key = bytes.fromhex("a5010203")
    row = {
        "id": "11111111-1111-1111-1111-111111111111",
        "user_id": "22222222-2222-2222-2222-222222222222",
        "credential_id": b"\\\\x0102ff",
        "public_key": b"\\\\xa5010203",
        "sign_count": "7",
        "backup_eligible": "t",
        "backed_up": "t",
        "transports": '["internal"]',
        "friendly_name": "Laptop",
        "created_at": "2026-11-01 00:00:00+00",
        "aaguid": None,
    }

    mapped = convert_passkey(row)

    assert base64.urlsafe_b64decode(mapped["credentialID"] + "==") == credential
    assert base64.b64decode(mapped["publicKey"]) == public_key
    assert mapped["counter"] == 7
    assert mapped["deviceType"] == "multiDevice"
    assert mapped["backedUp"] is True
    assert mapped["userId"] == row["user_id"]
    assert mapped["transports"] == "internal"


def test_read_copy_rows_uses_header_columns_and_preserves_bytea(tmp_path):
    dump = tmp_path / "auth.sql"
    dump.write_bytes(
        b'COPY "auth"."webauthn_credentials" ("user_id", "public_key") FROM stdin;\n'
        b"owner-id\t\\\\x0102\n"
        b"\\.\n"
    )

    assert list(read_copy_rows(dump, "webauthn_credentials")) == [
        {"user_id": b"owner-id", "public_key": b"\\\\x0102"}
    ]


def test_user_mapping_keeps_original_uuid_and_verified_email():
    row = {
        "id": b"22222222-2222-2222-2222-222222222222",
        "email": b"owner@example.com",
        "email_confirmed_at": b"2026-11-01 00:00:00+00",
        "created_at": b"2026-10-01 00:00:00+00",
        "updated_at": b"2026-11-01 00:00:00+00",
    }

    mapped = convert_user(row)

    assert mapped["id"] == "22222222-2222-2222-2222-222222222222"
    assert mapped["email"] == "owner@example.com"
    assert mapped["emailVerified"] is True
