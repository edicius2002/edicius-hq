"""
Every test gets its own data directory, whether it asks for one or not.

Most tests already did this by hand — `monkeypatch.setenv("LOCAL_DATA_DIR",
str(tmp_path))` appears in `test_kv` half a dozen times — and the ones that
didn't got away with it because they passed a `tmp_path` straight to
`FareHistory` or `FareCalendar` and never touched a default. `fare_budget`'s
ledger has no store to be handed: it is module state beside `HISTORY`, because
there is one address and therefore one day's spend, and a collector test that
fell back to the default would write into whatever `.local-data` the working
directory happens to name.

So the redirect moves up here and applies to everything. A test that wants a
different directory still sets one; this only decides where "no directory was
named" points, and it points somewhere that is thrown away afterwards.
"""

from uuid import UUID

import pytest


@pytest.fixture(autouse=True)
def _isolated_api_verifier(monkeypatch):
    """Keep legacy test credentials out of the production JWKS verifier."""
    from app import auth
    from app.services import auth_store
    from app.services.supabase_jwt import AuthenticatedUser, SupabaseTokenError

    class TestSessionVerifier:
        def verify(self, token: str) -> AuthenticatedUser:
            if auth_store.resolve_session(token) is None:
                raise SupabaseTokenError()
            return AuthenticatedUser(user_id=UUID("11111111-1111-1111-1111-111111111111"))

    verifier = TestSessionVerifier()
    monkeypatch.setattr(auth, "configured_verifier", lambda: verifier)


@pytest.fixture(autouse=True)
def _own_data_directory(tmp_path, monkeypatch):
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path / "local-data"))
    # JWT issuer validation is strict in production. Tests use the public,
    # fixed project identity and the suite verifier above; verifier-focused
    # tests provide their own MockTransport and never use this fake.
    monkeypatch.setenv("SUPABASE_URL", "https://abndifkxpfppmllgxfnu.supabase.co")
    # Lifespan tests must never reach the real X profile or launch Chromium.
    # Individual lifecycle tests opt in and replace the watcher at its boundary.
    monkeypatch.setenv("X_TWEET_WATCH_ON_START", "false")


@pytest.fixture(autouse=True)
def _unpaced_between_tests():
    """
    Each test starts with no Google request behind it.

    `GOOGLE_PACER` holds the last upstream start for the life of the process,
    which is what keeps two passes from addressing Google faster than the gap.
    Across tests that same memory is a leak: a pass that ran microseconds ago
    makes the next test really sleep three seconds before its first request,
    and `wait_for_the_pass` gives a pass five.
    """
    from app.services.fare_collector import GOOGLE_PACER

    GOOGLE_PACER.reset()
    yield
    GOOGLE_PACER.reset()


@pytest.fixture(autouse=True)
def _a_session_on_every_request(request, _own_data_directory, monkeypatch):
    """
    Every route needs a session now, so every `TestClient` request carries one.

    The production gate is strict JWT verification. This legacy opaque token
    exists only for remaining local-auth tests, and `_isolated_api_verifier`
    resolves it at the `configured_verifier` seam before it could reach a
    hosted JWKS endpoint. A test that means to arrive unauthenticated says so
    with `pytest.mark.unauthenticated`.

    The session is created per request rather than once per test on purpose.
    Several tests repoint `LOCAL_DATA_DIR` inside the test body (`test_kv` is
    the clearest), and a token minted before that move would be written into
    the directory the test just stopped using — so the gate would refuse a
    session this fixture had genuinely created, which is a confusing failure to
    debug for no gain. Minting at request time means the token always lands in
    whatever directory the request itself is about to read.
    """
    if request.node.get_closest_marker("unauthenticated"):
        return

    from starlette.testclient import TestClient

    from app.services import auth_store

    original = TestClient.request

    def request_with_a_session(self, method, url, **kwargs):
        headers = dict(kwargs.pop("headers", None) or {})
        if not any(name.lower() == "authorization" for name in headers):
            headers["Authorization"] = f"Bearer {auth_store.create_session()}"
        return original(self, method, url, headers=headers, **kwargs)

    monkeypatch.setattr(TestClient, "request", request_with_a_session)
