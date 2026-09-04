"""
`/api/auth/*` — the only routes that answer without a session, because they are
how a session is obtained.

Four of the seven are open by necessity. `session`, `logout` and
`enrolment-code` are not, and they carry `require_session` at their own
decorators rather than inheriting it, because this router is mounted without
the gate that `main.py` puts on everything else. `tests/test_gate.py` names the
four open ones and insists every other route under this prefix refuses without
a session, so a route added here cannot arrive open by accident.

**Every failure here is the same 401 with the same body.** Wrong code, spent
code, expired code, unknown credential, replayed challenge, refused assertion —
one answer. The client's recovery is identical in all of them (show the login
screen and say the attempt failed), and distinguishing them would report to an
unauthenticated caller on which codes and credentials exist. The one thing that
is not uniform is the failure *count*: `authorise_code` charges a miss whether
or not the caller learns anything from the response, which is what makes an
eight-character code worth using.
"""

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel

from app.auth import bearer_token, require_session
from app.services import auth_store, webauthn_ceremony

router = APIRouter(prefix="/api/auth", tags=["auth"])

REGISTRATION = "registration"
AUTHENTICATION = "authentication"


class LoginOptionsRequest(BaseModel):
    pass


class LoginVerifyRequest(BaseModel):
    #: camelCase on the model rather than an alias, which is how the rest of
    #: this API spells its wire fields — see `RouteResultModel.flightDate`.
    challengeId: str
    response: dict


class RegisterOptionsRequest(BaseModel):
    code: str


class RegisterVerifyRequest(BaseModel):
    #: camelCase on the model rather than an alias, which is how the rest of
    #: this API spells its wire fields — see `RouteResultModel.flightDate`.
    challengeId: str
    code: str
    response: dict
    # What the CLI's `credentials` listing shows. Cosmetic, so a client that
    # does not send one still enrols.
    label: str = "Passkey"


def _refuse() -> HTTPException:
    """The single answer. See the module docstring for why there is only one."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Authentication failed",
        headers={"WWW-Authenticate": "Bearer"},
    )


@router.post("/register/options")
def register_options(body: RegisterOptionsRequest) -> dict:
    """
    A challenge, but only for a caller holding a live enrolment code.

    The code is checked and not burned. Burning it here would mean a ceremony
    the owner cancels — closing the Windows Hello dialog — costs them a walk
    back to the PC for a new code, while buying nothing: `authorise_code`
    already charges the failure that stops guessing.
    """
    if not auth_store.authorise_code(body.code):
        raise _refuse()

    options, challenge = webauthn_ceremony.registration_options(auth_store.list_credentials())
    return {
        "challengeId": auth_store.store_challenge(challenge, REGISTRATION),
        "options": options,
    }


@router.post("/register/verify")
def register_verify(body: RegisterVerifyRequest) -> dict:
    """
    Stores the credential, burns the code, and returns a session.

    The session comes back from this call on purpose: enrolling a device and
    then being asked to sign in on it would be a second ceremony for something
    the owner has just proved.
    """
    challenge = auth_store.take_challenge(body.challengeId, REGISTRATION)
    if challenge is None:
        raise _refuse()

    try:
        registered = webauthn_ceremony.verify_registration(body.response, challenge)
    except webauthn_ceremony.CeremonyError as error:
        raise _refuse() from error

    # The burn happens after the ceremony and before the credential is stored,
    # so a code that expired while the owner was looking at the prompt enrols
    # nothing rather than enrolling on a dead authorisation.
    if not auth_store.consume_code(body.code):
        raise _refuse()

    auth_store.add_credential(
        registered.credential_id,
        registered.public_key,
        registered.sign_count,
        body.label,
    )
    return {"token": auth_store.create_session()}


@router.post("/login/options")
def login_options(_body: LoginOptionsRequest | None = None) -> dict:
    options, challenge = webauthn_ceremony.authentication_options(auth_store.list_credentials())
    return {
        "challengeId": auth_store.store_challenge(challenge, AUTHENTICATION),
        "options": options,
    }


@router.post("/login/verify")
def login_verify(body: LoginVerifyRequest) -> dict:
    challenge = auth_store.take_challenge(body.challengeId, AUTHENTICATION)
    if challenge is None:
        raise _refuse()

    try:
        credential_id = webauthn_ceremony.credential_id_from_response(body.response)
    except webauthn_ceremony.CeremonyError as error:
        raise _refuse() from error

    credential = auth_store.get_credential(credential_id)
    if credential is None:
        raise _refuse()

    try:
        sign_count = webauthn_ceremony.verify_authentication(body.response, challenge, credential)
    except webauthn_ceremony.CeremonyError as error:
        raise _refuse() from error

    auth_store.touch_credential(credential_id, sign_count)
    return {"token": auth_store.create_session()}


@router.get("/session", dependencies=[Depends(require_session)])
def read_session() -> dict:
    """
    Is this token still worth holding?

    The client asks on start-up so a token that expired while the tab was
    closed becomes the login screen rather than a wall of failed requests.
    """
    return {"authenticated": True}


@router.post(
    "/logout", status_code=status.HTTP_204_NO_CONTENT, dependencies=[Depends(require_session)]
)
def logout(request: Request) -> Response:
    auth_store.revoke_session(bearer_token(request))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/enrolment-code", dependencies=[Depends(require_session)])
def issue_enrolment_code() -> dict:
    """
    A code for the next device, asked for by a device that already has one.

    This is the route that loosens `cli/auth_cli.py`'s original claim that the
    only way to authorise a new device is a command on the PC. The trust it
    spends is real and deliberate: an enrolled device can now enrol another,
    so a stolen unlocked phone with a live session can add a passkey rather
    than only read the data. It buys the case that made the CLI painful —
    adding a second device from anywhere but the machine the API runs on — and
    the CLI stays the bootstrap path for the first device and for the day
    every device is gone.

    The gate does the refusing, so there is nothing here that could report on
    which codes exist: without a session `require_session` answers its own 401
    before the handler runs, exactly as it does for every other gated route in
    the app.

    **A duration, not an instant.** The client needs to say how long the code
    is good for, and it is the only clock the two ends share — the browser is
    often on a phone reaching this API over Tailscale, and two machines whose
    clocks disagree by a minute would have the page claim a code was dead
    while the store still honoured it, or the reverse. Ten minutes from *now*
    is true on either side of that.
    """
    return {
        "code": auth_store.issue_code(),
        "expiresInSeconds": int(auth_store.CODE_TTL.total_seconds()),
    }
