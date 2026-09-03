"""
The boundary around py_webauthn.

No real ceremony runs here — there is no browser and no authenticator — so what
is tested is what this module owns rather than what the library does: that the
options carry the configured relying party, that an enrolled credential is
named in the list the browser is given, that no third-party exception type
escapes, and that a sign count going backwards is refused.
"""

from datetime import UTC, datetime

import pytest

from app import config
from app.services import webauthn_ceremony
from app.services.auth_store import Credential


def _credential(credential_id: bytes = b"abc", sign_count: int = 0) -> Credential:
    return Credential(
        id="deadbeef",
        credential_id=credential_id,
        public_key=b"a-public-key",
        sign_count=sign_count,
        label="Test authenticator",
        created_at=datetime.now(UTC),
        last_used_at=None,
    )


def test_registration_options_carry_the_configured_rp():
    options, challenge = webauthn_ceremony.registration_options([])
    assert options["rp"]["id"] == config.WEBAUTHN_RP_ID
    assert len(challenge) >= 16


def test_registration_options_exclude_already_enrolled_credentials():
    existing = [_credential(b"abc")]
    options, _ = webauthn_ceremony.registration_options(existing)
    assert any(c["id"] for c in options["excludeCredentials"])


def test_registration_options_follow_the_configured_rp_id(monkeypatch):
    """Read at call time, not import time, so a deployment's value is the one used."""
    monkeypatch.setattr(config, "WEBAUTHN_RP_ID", "pc.example.ts.net")
    options, _ = webauthn_ceremony.registration_options([])
    assert options["rp"]["id"] == "pc.example.ts.net"


def test_authentication_options_allow_only_enrolled_credentials():
    options, challenge = webauthn_ceremony.authentication_options([_credential(b"abc")])
    assert options["rpId"] == config.WEBAUTHN_RP_ID
    assert len(options["allowCredentials"]) == 1
    assert len(challenge) >= 16


def test_verify_registration_wraps_library_failures():
    """No `webauthn.*` exception may reach the router."""
    with pytest.raises(webauthn_ceremony.CeremonyError):
        webauthn_ceremony.verify_registration({"not": "a credential"}, b"challenge")


def test_verify_authentication_wraps_library_failures():
    with pytest.raises(webauthn_ceremony.CeremonyError):
        webauthn_ceremony.verify_authentication(
            {"not": "a credential"}, b"challenge", _credential()
        )


def test_verify_authentication_rejects_a_regressed_sign_count(monkeypatch):
    """
    A sign count that goes backwards is WebAuthn's cloned-authenticator signal.

    The library refuses it too, which is why this stubs the library out: the
    point of the test is that *this* module keeps refusing it even if a future
    py_webauthn stops, so the guarantee cannot leave with a version bump.
    """

    class _Verified:
        new_sign_count = 3

    monkeypatch.setattr(
        webauthn_ceremony.py_webauthn,
        "verify_authentication_response",
        lambda **_kwargs: _Verified(),
    )
    with pytest.raises(webauthn_ceremony.CeremonyError):
        webauthn_ceremony.verify_authentication({}, b"challenge", _credential(sign_count=9))


def test_verify_authentication_accepts_an_advancing_sign_count(monkeypatch):
    """The other half of the check above: going forwards is what a real login does."""

    class _Verified:
        new_sign_count = 10

    monkeypatch.setattr(
        webauthn_ceremony.py_webauthn,
        "verify_authentication_response",
        lambda **_kwargs: _Verified(),
    )
    assert (
        webauthn_ceremony.verify_authentication({}, b"challenge", _credential(sign_count=9)) == 10
    )
