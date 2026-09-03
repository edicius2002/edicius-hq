"""
The test the whole feature rests on.

If a route can be added without a session being required, everything else here
is decoration, so the first test below is driven off the app's own route table
rather than a list anybody has to remember to update.
"""

import re

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from starlette.requests import Request

from app import auth
from app.main import app
from app.services import auth_store

client = TestClient(app)

# The one file that must not be handed a session: everything here is about
# what happens without one. `tests/conftest.py` gives every other request a
# real token, which is what keeps the rest of the suite honest rather than
# overriding the dependency.
pytestmark = pytest.mark.unauthenticated

# The four Server-Sent Events routes, which are the only ones allowed to carry
# the token in the query string. Written out here as well as in `app/auth.py`
# so the two have to agree — see `test_the_stream_exception_matches_the_route_table`.
STREAM_PATHS = {
    "/api/market/stream",
    "/api/fares/collect/stream",
    "/api/fares/calendar/collect/stream",
    "/api/tweets/{handle}/stream",
}


@pytest.fixture
def live_token():
    return auth_store.create_session()


def _fill_params(path: str) -> str:
    """Any value will do: the gate answers before a path parameter is looked at."""
    return re.sub(r"\{[^}]+\}", "placeholder", path)


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


def test_every_non_auth_route_is_gated():
    """
    Driven off the app's own route table rather than a hand-written list, so a
    router added later cannot quietly arrive unprotected.
    """
    checked = 0
    for route in app.routes:
        path = getattr(route, "path", "")
        if not path.startswith("/api/") or path.startswith("/api/auth/"):
            continue
        for method in getattr(route, "methods", set()) - {"HEAD", "OPTIONS"}:
            response = client.request(method, _fill_params(path))
            assert response.status_code == 401, f"{method} {path} answered without a session"
            checked += 1
    assert checked > 0, "the route table produced nothing to check"


def test_the_stream_exception_matches_the_route_table():
    """
    Both directions, so the exception cannot drift from the routes it describes.

    A stream route added later and not registered would otherwise get the
    header-only rule and simply never connect, with nothing failing here.
    """
    in_the_app = {
        path
        for route in app.routes
        if (path := getattr(route, "path", "")).startswith("/api/") and path.endswith("/stream")
    }
    assert in_the_app == STREAM_PATHS
    assert auth.STREAM_PATHS == STREAM_PATHS


def test_header_token_is_accepted(live_token):
    response = client.get("/api/kv/portfolio", headers={"Authorization": f"Bearer {live_token}"})
    assert response.status_code != 401


def test_query_string_token_is_refused_outside_the_streams(live_token):
    # The query-string shortcut exists because EventSource cannot set headers.
    # It must not become a second, weaker way into the rest of the API.
    response = client.get(f"/api/kv/portfolio?token={live_token}")
    assert response.status_code == 401


def test_query_string_token_is_accepted_on_a_stream(live_token):
    """
    A 400, and it has to be, which is worth explaining rather than hiding.

    An accepted SSE response never completes, and neither `TestClient` nor
    httpx's ASGI transport hands back a status line before the body is done —
    both were tried, and both hang. So the request is made in a way the
    endpoint itself will refuse: an empty `symbols` list. Reaching that refusal
    is the assertion. A 400 comes from `stream_quotes`' own validation, which
    only runs once the gate has already let the request through, so it proves
    the query-string token was accepted exactly as a 200 would.
    """
    response = client.get(f"/api/market/stream?symbols=&token={live_token}")
    assert response.status_code == 400


def test_a_stream_without_any_token_is_still_refused(live_token):
    """The other half: the shortcut is a way in with a token, not a way around one."""
    assert client.get("/api/market/stream?symbols=").status_code == 401
    assert client.get("/api/market/stream?symbols=&token=not-a-real-token").status_code == 401


class TestTheTwoRulesDirectly:
    """
    The dependencies themselves, away from any route.

    This is where the shortcut is pinned to the streams: the same request is
    accepted by one rule and refused by the other, which is the fact the
    routing above is arranging and not something it can demonstrate on its own.
    """

    def test_require_session_accepts_the_header(self, live_token):
        request = _fake_request(headers={"Authorization": f"Bearer {live_token}"})
        assert auth.require_session(request) is not None

    def test_require_session_refuses_a_query_string_token(self, live_token):
        request = _fake_request(query=f"token={live_token}")
        with pytest.raises(HTTPException) as raised:
            auth.require_session(request)
        assert raised.value.status_code == 401

    def test_require_session_stream_accepts_a_query_string_token(self, live_token):
        request = _fake_request(query=f"token={live_token}")
        assert auth.require_session_stream(request) is not None

    def test_require_session_stream_still_prefers_the_header(self, live_token):
        request = _fake_request(
            headers={"Authorization": f"Bearer {live_token}"}, query="token=rubbish"
        )
        assert auth.require_session_stream(request) is not None

    def test_neither_rule_accepts_a_malformed_header(self, live_token):
        for header in (f"Basic {live_token}", live_token, "Bearer", "Bearer "):
            request = _fake_request(headers={"Authorization": header})
            with pytest.raises(HTTPException):
                auth.require_session(request)


def test_health_is_gated():
    """
    Deliberate, and visible: the status indicator reads "API offline" while
    signed out. Honest, and it leaks nothing — the login screen is what the
    visitor sees anyway.
    """
    assert client.get("/api/health").status_code == 401


def test_a_revoked_session_stops_working(live_token):
    headers = {"Authorization": f"Bearer {live_token}"}
    assert client.get("/api/kv/portfolio", headers=headers).status_code != 401
    auth_store.revoke_session(live_token)
    assert client.get("/api/kv/portfolio", headers=headers).status_code == 401
