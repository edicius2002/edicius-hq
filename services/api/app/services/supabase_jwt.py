"""Strict, JWKS-backed verification for Supabase access tokens."""

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from time import monotonic
from typing import cast
from uuid import UUID

import httpx
import jwt
from jwt.algorithms import AllowedPublicKeys
from jwt.types import Options

ALLOWED_ALGORITHMS = frozenset({"ES256", "RS256"})
REQUIRED_CLAIMS = ("exp", "iat", "nbf", "iss", "aud", "sub", "role")
JWKS_CACHE_SECONDS = 10 * 60


class SupabaseTokenError(Exception):
    """A token or JWKS failure that must be presented as an unauthenticated request."""


@dataclass(frozen=True, slots=True)
class AuthenticatedUser:
    user_id: UUID


class SupabaseJwtVerifier:
    """Verify one Supabase JWT against cached public signing keys."""

    def __init__(
        self,
        *,
        issuer: str,
        audience: str,
        jwks_url: str,
        client: httpx.Client | None = None,
        clock: Callable[[], float] | None = None,
    ) -> None:
        self._issuer = issuer
        self._audience = audience
        self._jwks_url = jwks_url
        self._client = client or httpx.Client()
        self._clock = clock or monotonic
        self._cached_keys: dict[str, AllowedPublicKeys] | None = None
        self._cache_expires_at = 0.0

    def verify(self, token: str) -> AuthenticatedUser:
        """Return the authenticated UUID only when every access-token claim verifies."""
        try:
            header = jwt.get_unverified_header(token)
            algorithm = header.get("alg")
            kid = header.get("kid")
            if algorithm not in ALLOWED_ALGORITHMS or not isinstance(kid, str) or not kid:
                raise SupabaseTokenError()

            options: Options = {"require": list(REQUIRED_CLAIMS)}
            claims = jwt.decode(
                token,
                self._key_for(kid),
                algorithms=[algorithm],
                audience=self._audience,
                issuer=self._issuer,
                options=options,
            )
            if claims.get("role") != "authenticated":
                raise SupabaseTokenError()
            subject = claims.get("sub")
            if not isinstance(subject, str):
                raise SupabaseTokenError()
            return AuthenticatedUser(user_id=UUID(subject))
        except SupabaseTokenError:
            raise
        except (httpx.HTTPError, jwt.PyJWTError, TypeError, ValueError) as error:
            raise SupabaseTokenError() from error

    def _key_for(self, kid: str) -> AllowedPublicKeys:
        keys = self._cached_jwks()
        key = keys.get(kid)
        if key is not None:
            return key

        # A fresh response can contain a rotated signing key even when the
        # ordinary ten-minute cache has not expired. One retry is enough: more
        # requests cannot turn an unknown key identifier into a trusted key.
        keys = self._refresh_jwks()
        key = keys.get(kid)
        if key is None:
            raise SupabaseTokenError()
        return key

    def _cached_jwks(self) -> dict[str, AllowedPublicKeys]:
        if self._cached_keys is None or self._clock() >= self._cache_expires_at:
            return self._refresh_jwks()
        return self._cached_keys

    def _refresh_jwks(self) -> dict[str, AllowedPublicKeys]:
        response = self._client.get(self._jwks_url)
        response.raise_for_status()
        payload = response.json()
        if not isinstance(payload, Mapping) or not isinstance(payload.get("keys"), list):
            raise SupabaseTokenError()

        keys: dict[str, AllowedPublicKeys] = {}
        for raw_key in payload["keys"]:
            if not isinstance(raw_key, dict):
                raise SupabaseTokenError()
            kid = raw_key.get("kid")
            if not isinstance(kid, str) or not kid:
                raise SupabaseTokenError()
            keys[kid] = cast(AllowedPublicKeys, jwt.PyJWK.from_dict(raw_key).key)

        self._cached_keys = keys
        self._cache_expires_at = self._clock() + JWKS_CACHE_SECONDS
        return keys
