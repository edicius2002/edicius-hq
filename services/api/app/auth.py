"""
The gate.

Two rules and one place that decides which of them a request gets.

`require_session` reads the `Authorization: Bearer` header and nothing else.
`require_session_stream` reads that header first and falls back to a `token`
query parameter. The second exists only because `EventSource` cannot set
request headers, and it is deliberately not the general rule: a token in a
query string is normally a defect because intermediaries log URLs, and the
argument that there is no intermediary here holds only while TLS terminates on
the owner's own machine. Anyone moving this API behind Cloudflare, ngrok or a
Vercel rewrite is putting the session token in someone else's logs and must
revisit this.

**Which mechanism won, and why.** Both rules are applied by `require_session_gate`,
a single dependency attached where the routers are included in `main.py`. The
obvious alternative — the header-only rule on the routers and
`dependencies=[Depends(require_session_stream)]` on the four stream route
decorators — does not work, and the reason is worth writing down because the
code reads as though it should. FastAPI *combines* those two lists rather than
letting the narrower one win: `include_router` puts the router-level
dependencies first and the route's own after, so the header-only rule would run
first and answer 401 before the stream rule was ever consulted. A route-level
dependency cannot loosen a router-level one; it can only add to it.

So the dispatch happens inside the gate instead, by asking the matched route
for its path. The list below is therefore the whole of the exception, and
`tests/test_gate.py` checks it against the app's own route table in both
directions: every path here exists, and every route in the app whose path ends
in `/stream` is named here. A fifth stream route added later fails that test
rather than silently getting the header-only rule and never connecting.
"""

from fastapi import HTTPException, Request, status

from app.services import auth_store
from app.services.auth_store import Session

# The only routes that may carry the session token in the query string.
# Path templates, matched against the route the request resolved to, so the
# parameter in the tweets one does not have to be guessed at.
STREAM_PATHS = frozenset(
    {
        "/api/market/stream",
        "/api/fares/collect/stream",
        "/api/fares/calendar/collect/stream",
        "/api/tweets/{handle}/stream",
    }
)

# The query parameter the four stream routes accept the token in.
TOKEN_QUERY_PARAM = "token"


def _unauthenticated() -> HTTPException:
    """
    One answer for every way of not being signed in.

    Expired, revoked, malformed and never-existed are the same response on
    purpose: the client's recovery is identical in all four cases — clear the
    token and show the login screen — and telling them apart would report on
    which tokens exist.
    """
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


def _bearer_token(request: Request) -> str:
    header = request.headers.get("authorization", "")
    scheme, _, token = header.partition(" ")
    if scheme.lower() != "bearer":
        return ""
    return token.strip()


def require_session(request: Request) -> Session:
    """The rule for everything that is not a stream: the header, and only the header."""
    session = auth_store.resolve_session(_bearer_token(request))
    if session is None:
        raise _unauthenticated()
    return session


def require_session_stream(request: Request) -> Session:
    """The rule for the four SSE routes: the header, or `?token=` when there is none."""
    token = _bearer_token(request) or request.query_params.get(TOKEN_QUERY_PARAM, "")
    session = auth_store.resolve_session(token)
    if session is None:
        raise _unauthenticated()
    return session


def require_session_gate(request: Request) -> Session:
    """
    The one dependency `main.py` attaches, applying whichever rule the route earns.

    Failing closed is the default: a route this does not recognise gets the
    header-only rule, so a stream route that nobody added to `STREAM_PATHS`
    stops working rather than quietly accepting a weaker credential.
    """
    route = request.scope.get("route")
    if getattr(route, "path", "") in STREAM_PATHS:
        return require_session_stream(request)
    return require_session(request)
