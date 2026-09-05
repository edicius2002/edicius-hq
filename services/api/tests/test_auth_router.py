"""
The six endpoints that hand out and retire sessions.

No real ceremony runs — there is no authenticator here — so the two `verify`
routes are tested with `webauthn_ceremony` stubbed at its own boundary. That is
the boundary's purpose: everything on this side of it is this router's logic,
and it is the part that can be wrong in ways a browser would not notice.
"""

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import auth_store, webauthn_ceremony

client = TestClient(app)

# These routes are how a session is obtained, so arriving with one already is
# the wrong starting position for almost every test here. The two that need a
# session pass it explicitly.
pytestmark = pytest.mark.unauthenticated

A_CREDENTIAL_ID = b"credential-1"


@pytest.fixture
def live_token():
    return auth_store.create_session()


@pytest.fixture
def enrolled():
    return auth_store.add_credential(A_CREDENTIAL_ID, b"a-public-key", 1, "Test key")


def _registered(monkeypatch, credential_id: bytes = A_CREDENTIAL_ID, sign_count: int = 1):
    monkeypatch.setattr(
        webauthn_ceremony,
        "verify_registration",
        lambda response, challenge: webauthn_ceremony.RegisteredCredential(
            credential_id=credential_id, public_key=b"a-public-key", sign_count=sign_count
        ),
    )


def _authenticated(monkeypatch, new_sign_count: int = 2):
    monkeypatch.setattr(
        webauthn_ceremony, "verify_authentication", lambda *_args, **_kwargs: new_sign_count
    )
    monkeypatch.setattr(
        webauthn_ceremony, "credential_id_from_response", lambda _response: A_CREDENTIAL_ID
    )


def _start_registration() -> tuple[str, str]:
    """Issues a code, starts a ceremony with it, and returns both."""
    code = auth_store.issue_code()
    response = client.post("/api/auth/register/options", json={"code": code})
    assert response.status_code == 200
    return code, response.json()["challengeId"]


class TestEnrolmentCodes:
    def test_registration_is_refused_without_a_valid_code(self):
        response = client.post("/api/auth/register/options", json={"code": "BADCODE1"})
        assert response.status_code == 401

    def test_a_wrong_code_is_indistinguishable_from_an_expired_one(self):
        """
        The response may not report on which codes exist. Same status, same
        body, whether the code was never issued or was issued and spent.
        """
        never_existed = client.post("/api/auth/register/options", json={"code": "22222222"})

        spent = auth_store.issue_code()
        assert auth_store.consume_code(spent) is True
        already_used = client.post("/api/auth/register/options", json={"code": spent})

        assert never_existed.status_code == already_used.status_code
        assert never_existed.json() == already_used.json()

    def test_a_live_code_gets_a_challenge(self):
        _, challenge_id = _start_registration()
        assert challenge_id

    def test_the_printed_separator_is_accepted(self):
        code = auth_store.issue_code()
        formatted = f"{code[:4]}-{code[4:]}".lower()
        response = client.post("/api/auth/register/options", json={"code": formatted})
        assert response.status_code == 200

    def test_options_do_not_burn_the_code(self):
        """A cancelled ceremony must not cost a trip back to the PC."""
        code, _ = _start_registration()
        assert client.post("/api/auth/register/options", json={"code": code}).status_code == 200

    def test_five_wrong_guesses_kill_a_live_code(self):
        code = auth_store.issue_code()
        for _ in range(5):
            client.post("/api/auth/register/options", json={"code": "22222222"})
        assert client.post("/api/auth/register/options", json={"code": code}).status_code == 401


class TestIssuingACodeFromAnEnrolledDevice:
    """
    The route that lets a device already holding a session authorise the next
    one, so adding a second device no longer means walking to the PC.
    """

    def test_a_session_gets_a_code_that_starts_a_registration(self, live_token):
        response = client.post(
            "/api/auth/enrolment-code", headers={"Authorization": f"Bearer {live_token}"}
        )

        assert response.status_code == 200
        issued = response.json()
        # End to end rather than against the store: the code is worth having
        # because the enrolment route accepts it, and that is the assertion.
        assert (
            client.post("/api/auth/register/options", json={"code": issued["code"]}).status_code
            == 200
        )
        assert issued["expiresInSeconds"] == 600

    def test_it_is_refused_without_a_session(self):
        """
        The one failure this route has. It is `require_session`'s 401 and not
        `_refuse`'s, which is right: not being signed in is a gate failure and
        answers like every other gated route, rather than reporting on a
        ceremony this caller never started.
        """
        assert client.post("/api/auth/enrolment-code").status_code == 401

    def test_a_new_code_kills_the_one_before_it(self, live_token):
        """
        One live code at a time. The second ask is what the owner does when the
        first code got away from them — a menu they closed, a walk they
        abandoned — and the one they gave up on must stop working then, not
        ten minutes later.
        """
        auth = {"Authorization": f"Bearer {live_token}"}
        first = client.post("/api/auth/enrolment-code", headers=auth).json()["code"]
        second = client.post("/api/auth/enrolment-code", headers=auth).json()["code"]

        assert client.post("/api/auth/register/options", json={"code": first}).status_code == 401
        assert client.post("/api/auth/register/options", json={"code": second}).status_code == 200

    def test_the_code_it_issues_enrols_a_device(self, monkeypatch, live_token):
        """The whole point, walked once: session in, second passkey out."""
        _registered(monkeypatch, credential_id=b"the-second-device")
        code = client.post(
            "/api/auth/enrolment-code", headers={"Authorization": f"Bearer {live_token}"}
        ).json()["code"]

        challenge_id = client.post("/api/auth/register/options", json={"code": code}).json()[
            "challengeId"
        ]
        response = client.post(
            "/api/auth/register/verify",
            json={"challengeId": challenge_id, "code": code, "response": {"id": "x"}},
        )

        assert response.status_code == 200
        assert auth_store.get_credential(b"the-second-device") is not None
        # And the code is spent, exactly as one from the CLI would be.
        assert client.post("/api/auth/register/options", json={"code": code}).status_code == 401


class TestRegistration:
    def test_verify_stores_the_credential_and_returns_a_token(self, monkeypatch):
        _registered(monkeypatch)
        code, challenge_id = _start_registration()

        response = client.post(
            "/api/auth/register/verify",
            json={"challengeId": challenge_id, "code": code, "response": {"id": "x"}},
        )

        assert response.status_code == 200
        token = response.json()["token"]
        assert auth_store.resolve_session(token) is not None
        assert auth_store.get_credential(A_CREDENTIAL_ID) is not None

    def test_verify_burns_the_code(self, monkeypatch):
        _registered(monkeypatch)
        code, challenge_id = _start_registration()
        client.post(
            "/api/auth/register/verify",
            json={"challengeId": challenge_id, "code": code, "response": {"id": "x"}},
        )
        assert client.post("/api/auth/register/options", json={"code": code}).status_code == 401

    def test_verify_is_refused_with_a_spent_challenge(self, monkeypatch):
        _registered(monkeypatch)
        code, challenge_id = _start_registration()
        body = {"challengeId": challenge_id, "code": code, "response": {"id": "x"}}
        assert client.post("/api/auth/register/verify", json=body).status_code == 200
        assert client.post("/api/auth/register/verify", json=body).status_code == 401

    def test_a_failed_ceremony_stores_nothing(self, monkeypatch):
        def refuse(response, challenge):
            raise webauthn_ceremony.CeremonyError("no")

        monkeypatch.setattr(webauthn_ceremony, "verify_registration", refuse)
        code, challenge_id = _start_registration()

        response = client.post(
            "/api/auth/register/verify",
            json={"challengeId": challenge_id, "code": code, "response": {"id": "x"}},
        )

        assert response.status_code == 401
        assert auth_store.list_credentials() == []


class TestLogin:
    def test_options_return_a_challenge(self, enrolled):
        response = client.post("/api/auth/login/options", json={})
        assert response.status_code == 200
        assert response.json()["challengeId"]
        assert response.json()["options"]["challenge"]

    def test_verify_returns_a_token_and_advances_the_sign_count(self, monkeypatch, enrolled):
        _authenticated(monkeypatch, new_sign_count=7)
        challenge_id = client.post("/api/auth/login/options", json={}).json()["challengeId"]

        response = client.post(
            "/api/auth/login/verify",
            json={"challengeId": challenge_id, "response": {"id": "x"}},
        )

        assert response.status_code == 200
        assert auth_store.resolve_session(response.json()["token"]) is not None
        stored = auth_store.get_credential(A_CREDENTIAL_ID)
        assert stored is not None
        assert stored.sign_count == 7
        assert stored.last_used_at is not None

    def test_verify_is_refused_for_a_credential_that_is_not_enrolled(self, monkeypatch):
        _authenticated(monkeypatch)
        challenge_id = client.post("/api/auth/login/options", json={}).json()["challengeId"]
        response = client.post(
            "/api/auth/login/verify",
            json={"challengeId": challenge_id, "response": {"id": "x"}},
        )
        assert response.status_code == 401

    def test_a_registration_challenge_cannot_be_spent_on_the_login_route(
        self, monkeypatch, enrolled
    ):
        _authenticated(monkeypatch)
        _, challenge_id = _start_registration()
        response = client.post(
            "/api/auth/login/verify",
            json={"challengeId": challenge_id, "response": {"id": "x"}},
        )
        assert response.status_code == 401


class TestTheSession:
    def test_session_reports_a_live_token(self, live_token):
        response = client.get(
            "/api/auth/session", headers={"Authorization": f"Bearer {live_token}"}
        )
        assert response.status_code == 200

    def test_session_is_refused_without_one(self):
        assert client.get("/api/auth/session").status_code == 401

    def test_logout_kills_the_session(self, live_token):
        auth = {"Authorization": f"Bearer {live_token}"}
        assert client.post("/api/auth/logout", headers=auth).status_code in (200, 204)
        assert client.get("/api/auth/session", headers=auth).status_code == 401

    def test_logout_needs_a_session_of_its_own(self):
        assert client.post("/api/auth/logout").status_code == 401
