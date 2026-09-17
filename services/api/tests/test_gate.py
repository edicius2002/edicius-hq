"""Every private route shares the same header-only Supabase JWT gate."""

import re
from uuid import UUID

import pytest
from fastapi import HTTPException
from fastapi.routing import iter_route_contexts
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import auth
from app.main import app
from app.services.supabase_jwt import AuthenticatedUser, SupabaseTokenError

client = TestClient(app)

pytestmark = pytest.mark.unauthenticated

OPEN_AUTH_PATHS = {
    "/api/auth/register/options",
    "/api/auth/register/verify",
    "/api/auth/login/options",
    "/api/auth/login/verify",
}
TOKEN = "test-supabase-access-token"


@pytest.fixture
def verified_user() -> AuthenticatedUser:
    return AuthenticatedUser(user_id=UUID("11111111-1111-1111-1111-111111111111"))


@pytest.fixture
def configured_gate(monkeypatch, verified_user):
    class TestVerifier:
        def verify(self, token: str) -> AuthenticatedUser:
            if token == TOKEN:
                return verified_user
            raise SupabaseTokenError()

    monkeypatch.setattr(auth, "configured_verifier", lambda: TestVerifier())


def _fill_params(path: str) -> str:
    return re.sub(r"\{[^}]+\}", "placeholder", path)


def _private_routes():
    for route in iter_route_contexts(app.routes):
        path = getattr(route, "path", "")
        if not path.startswith("/api/") or path in OPEN_AUTH_PATHS:
            continue
        yield route


def _fake_request(headers: dict[str, str] | None = None, query: str = "") -> Request:
    return Request(
        {
            "type": "http",
            "method": "GET",
            "path": "/api/kv/portfolio",
            "query_string": query.encode(),
            "headers": [
                (key.lower().encode(), value.encode()) for key, value in (headers or {}).items()
            ],
        }
    )


def test_every_private_route_uses_the_same_header_only_dependency():
    checked = 0
    for route in _private_routes():
        calls = {dependency.call for dependency in route.dependant.dependencies}
        assert auth.require_session in calls, route.path
        checked += 1
    assert checked > 0


def test_every_private_route_refuses_a_query_string_token():
    checked = 0
    for route in _private_routes():
        for method in route.methods - {"HEAD", "OPTIONS"}:
            response = client.request(method, f"{_fill_params(route.path)}?token={TOKEN}")
            assert response.status_code == 401, f"{method} {route.path} accepted a query token"
            checked += 1
    assert checked > 0


def test_header_token_is_accepted(configured_gate):
    response = client.get("/api/kv/portfolio", headers={"Authorization": f"Bearer {TOKEN}"})

    assert response.status_code != 401


def test_query_string_token_is_refused_even_on_a_stream():
    response = client.get(f"/api/market/stream?symbols=&token={TOKEN}")

    assert response.status_code == 401


def test_require_session_returns_the_authenticated_user_from_the_verifier(
    configured_gate, verified_user
):
    request = _fake_request(headers={"Authorization": f"Bearer {TOKEN}"})

    assert auth.require_session(request) == verified_user


def test_require_session_has_one_unauthenticated_answer_for_invalid_credentials(configured_gate):
    failures = []
    for request in (
        _fake_request(),
        _fake_request(headers={"Authorization": "Basic credentials"}),
        _fake_request(headers={"Authorization": "Bearer wrong-token"}),
        _fake_request(query=f"token={TOKEN}"),
    ):
        with pytest.raises(HTTPException) as raised:
            auth.require_session(request)
        failures.append(raised.value)

    for error in failures:
        assert error.status_code == 401
        assert error.detail == "Not authenticated"
        assert error.headers == {"WWW-Authenticate": "Bearer"}
