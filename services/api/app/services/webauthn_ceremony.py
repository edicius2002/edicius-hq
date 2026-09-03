"""
The one place `webauthn` is imported.

Same shape as the Yahoo and Binance adapters: a third-party library is spoken
to from exactly one module, so the routers depend on this file's vocabulary
rather than on py_webauthn's. Two things follow from that and both are
deliberate.

**No library exception escapes.** Every call is wrapped and re-raised as
`CeremonyError`. A router that had to catch `InvalidRegistrationResponse`,
`InvalidJSONStructure` and `SignatureVerificationException` by name would be a
router that breaks when the library renames one, and the failure mode there is
an unhandled 500 on the login path — the one route that has to keep answering
cleanly to a visitor who is not signed in.

**Options go out as plain JSON.** `options_to_json` produces exactly the shape
`navigator.credentials` wants, base64url and all, so the client does no
translation and there is no second encoding to keep in step.
"""

import json
from dataclasses import dataclass

import webauthn as py_webauthn
from webauthn.helpers.exceptions import WebAuthnException
from webauthn.helpers.structs import (
    AuthenticatorSelectionCriteria,
    PublicKeyCredentialCreationOptions,
    PublicKeyCredentialDescriptor,
    PublicKeyCredentialRequestOptions,
    ResidentKeyRequirement,
    UserVerificationRequirement,
)

from app import config
from app.services.auth_store import Credential

# There is one user. The name is what the authenticator shows in its own
# picker, so it is written for a human looking at a Windows Hello dialog rather
# than for the API.
RP_NAME = "Edicius HQ"
USER_NAME = "owner"
USER_DISPLAY_NAME = "Edicius HQ owner"

# Stable across enrolments on purpose: a new user handle each time would make
# the same authenticator offer a second passkey rather than replace the first.
USER_HANDLE = b"edicius-hq-owner"


class CeremonyError(Exception):
    """Anything that went wrong in a WebAuthn ceremony, with no library type attached."""


@dataclass(frozen=True)
class RegisteredCredential:
    credential_id: bytes
    public_key: bytes
    sign_count: int


def _descriptors(existing: list[Credential]) -> list[PublicKeyCredentialDescriptor]:
    return [PublicKeyCredentialDescriptor(id=credential.credential_id) for credential in existing]


def _as_json(
    options: PublicKeyCredentialCreationOptions | PublicKeyCredentialRequestOptions,
) -> dict:
    return json.loads(py_webauthn.options_to_json(options))


def registration_options(existing: list[Credential]) -> tuple[dict, bytes]:
    """
    Options for `navigator.credentials.create()`, and the challenge to keep.

    `existing` becomes `excludeCredentials`, which is what stops an
    authenticator that is already enrolled from quietly enrolling twice and
    leaving the owner with two credentials where they believe they have one.
    """
    try:
        options = py_webauthn.generate_registration_options(
            rp_id=config.WEBAUTHN_RP_ID,
            rp_name=RP_NAME,
            user_id=USER_HANDLE,
            user_name=USER_NAME,
            user_display_name=USER_DISPLAY_NAME,
            exclude_credentials=_descriptors(existing),
            authenticator_selection=AuthenticatorSelectionCriteria(
                # A discoverable credential is what lets the login screen offer
                # the passkey without first being told who is signing in —
                # there is one user, so there is nothing to ask.
                resident_key=ResidentKeyRequirement.PREFERRED,
                user_verification=UserVerificationRequirement.PREFERRED,
            ),
        )
    except WebAuthnException as error:
        raise CeremonyError(str(error)) from error
    return _as_json(options), options.challenge


def verify_registration(response: dict, challenge: bytes) -> RegisteredCredential:
    try:
        verified = py_webauthn.verify_registration_response(
            credential=response,
            expected_challenge=challenge,
            expected_rp_id=config.WEBAUTHN_RP_ID,
            expected_origin=config.WEBAUTHN_ORIGIN,
        )
    except (WebAuthnException, ValueError, KeyError, TypeError) as error:
        # `ValueError` and friends are here because a response is client-supplied
        # JSON: a malformed one fails while being parsed, before any WebAuthn
        # rule gets a chance to reject it, and that is still a failed ceremony
        # rather than a bug in this process.
        raise CeremonyError(str(error)) from error
    return RegisteredCredential(
        credential_id=verified.credential_id,
        public_key=verified.credential_public_key,
        sign_count=verified.sign_count,
    )


def authentication_options(existing: list[Credential]) -> tuple[dict, bytes]:
    """Options for `navigator.credentials.get()`, and the challenge to keep."""
    try:
        options = py_webauthn.generate_authentication_options(
            rp_id=config.WEBAUTHN_RP_ID,
            allow_credentials=_descriptors(existing),
            user_verification=UserVerificationRequirement.PREFERRED,
        )
    except WebAuthnException as error:
        raise CeremonyError(str(error)) from error
    return _as_json(options), options.challenge


def verify_authentication(response: dict, challenge: bytes, credential: Credential) -> int:
    """Returns the new sign count, or raises `CeremonyError`."""
    try:
        verified = py_webauthn.verify_authentication_response(
            credential=response,
            expected_challenge=challenge,
            expected_rp_id=config.WEBAUTHN_RP_ID,
            expected_origin=config.WEBAUTHN_ORIGIN,
            credential_public_key=credential.public_key,
            credential_current_sign_count=credential.sign_count,
        )
    except (WebAuthnException, ValueError, KeyError, TypeError) as error:
        raise CeremonyError(str(error)) from error

    new_sign_count = verified.new_sign_count
    # py_webauthn refuses this too, and this is not that check repeated for
    # symmetry: a sign count going backwards is the cloned-authenticator
    # signal, and it is the one WebAuthn rule this API would rather fail closed
    # on than inherit. Keeping it here means a library that relaxes the rule —
    # several implementations treat it as advisory — cannot take the guarantee
    # away in a version bump without a test here going red.
    if (
        new_sign_count > 0 or credential.sign_count > 0
    ) and new_sign_count <= credential.sign_count:
        raise CeremonyError(
            "Sign count went backwards; this credential needs to be revoked and re-enrolled"
        )
    return new_sign_count
