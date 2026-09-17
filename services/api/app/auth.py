"""The one header-only FastAPI gate for Supabase access tokens."""

from fastapi import HTTPException, Request, status

from app.config import supabase_jwt_config
from app.services.supabase_jwt import AuthenticatedUser, SupabaseJwtVerifier, SupabaseTokenError

_verifier: SupabaseJwtVerifier | None = None


def _unauthenticated() -> HTTPException:
    """Return the uniform public answer for every invalid credential."""
    return HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Not authenticated",
        headers={"WWW-Authenticate": "Bearer"},
    )


def bearer_token(request: Request) -> str:
    """Read an RFC 6750 Bearer credential from the Authorization header only."""
    scheme, separator, token = request.headers.get("authorization", "").partition(" ")
    if scheme.casefold() != "bearer" or not separator:
        return ""
    return token.strip()


def configured_verifier() -> SupabaseJwtVerifier:
    """Build the process-wide verifier only after the exact issuer is validated."""
    global _verifier
    if _verifier is None:
        config = supabase_jwt_config()
        _verifier = SupabaseJwtVerifier(
            issuer=config.issuer,
            audience=config.audience,
            jwks_url=config.jwks_url,
        )
    return _verifier


def require_session(request: Request) -> AuthenticatedUser:
    """Require one valid Supabase bearer token for every private API route."""
    token = bearer_token(request)
    if not token:
        raise _unauthenticated()
    try:
        return configured_verifier().verify(token)
    except SupabaseTokenError as error:
        raise _unauthenticated() from error


require_session_gate = require_session
