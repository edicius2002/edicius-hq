"""The API accepts only signed Supabase access tokens, never local sessions."""

import json
from collections.abc import Callable
from datetime import UTC, datetime
from uuid import UUID

import httpx
import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec, rsa

from app.config import supabase_jwt_config
from app.services.supabase_jwt import (
    AuthenticatedUser,
    SupabaseJwtVerifier,
    SupabaseTokenError,
)

ISSUER = "https://abndifkxpfppmllgxfnu.supabase.co/auth/v1"
JWKS_URL = f"{ISSUER}/.well-known/jwks.json"
AUDIENCE = "authenticated"
SUBJECT = "11111111-1111-1111-1111-111111111111"


def test_derives_the_exact_supabase_issuer_and_jwks_url(monkeypatch):
    monkeypatch.setenv("SUPABASE_URL", "https://abndifkxpfppmllgxfnu.supabase.co/")

    config = supabase_jwt_config()

    assert config.issuer == ISSUER
    assert config.jwks_url == JWKS_URL
    assert config.audience == AUDIENCE


@pytest.mark.parametrize(
    "url",
    ["http://abndifkxpfppmllgxfnu.supabase.co", "https://wrong-project.supabase.co"],
)
def test_rejects_any_supabase_url_other_than_the_exact_project_host(monkeypatch, url):
    monkeypatch.setenv("SUPABASE_URL", url)

    with pytest.raises(ValueError, match="edicius-hq HTTPS project host"):
        supabase_jwt_config()


def test_rejects_a_missing_supabase_url(monkeypatch):
    monkeypatch.delenv("SUPABASE_URL", raising=False)

    with pytest.raises(ValueError, match="SUPABASE_URL"):
        supabase_jwt_config()


def _claims(**changes: object) -> dict[str, object]:
    now = int(datetime.now(UTC).timestamp())
    claims: dict[str, object] = {
        "iss": ISSUER,
        "aud": AUDIENCE,
        "role": "authenticated",
        "sub": SUBJECT,
        "iat": now,
        "nbf": now,
        "exp": now + 300,
    }
    claims.update(changes)
    return claims


def _jwk(private_key: object, kid: str, algorithm: str) -> dict[str, str]:
    if algorithm == "ES256":
        encoded = jwt.algorithms.ECAlgorithm.to_jwk(private_key.public_key())
    else:
        encoded = jwt.algorithms.RSAAlgorithm.to_jwk(private_key.public_key())
    return json.loads(encoded) | {"alg": algorithm, "kid": kid, "use": "sig"}


def _token(private_key: object, kid: str, algorithm: str, **changes: object) -> str:
    return jwt.encode(_claims(**changes), private_key, algorithm=algorithm, headers={"kid": kid})


def _verifier(
    handler: Callable[[httpx.Request], httpx.Response],
    *,
    clock: Callable[[], float] | None = None,
) -> SupabaseJwtVerifier:
    return SupabaseJwtVerifier(
        issuer=ISSUER,
        audience=AUDIENCE,
        jwks_url=JWKS_URL,
        client=httpx.Client(transport=httpx.MockTransport(handler)),
        clock=clock,
    )


@pytest.fixture
def signing_key():
    return ec.generate_private_key(ec.SECP256R1())


def test_verifies_an_es256_token_and_returns_its_uuid_subject(signing_key):
    kid = "test-key"
    verifier = _verifier(
        lambda _request: httpx.Response(200, json={"keys": [_jwk(signing_key, kid, "ES256")]})
    )

    user = verifier.verify(_token(signing_key, kid, "ES256"))

    assert user == AuthenticatedUser(user_id=UUID(SUBJECT))


def test_verifies_a_supabase_access_token_without_an_optional_nbf_claim(signing_key):
    kid = "test-key"
    verifier = _verifier(
        lambda _request: httpx.Response(200, json={"keys": [_jwk(signing_key, kid, "ES256")]})
    )
    claims = _claims()
    del claims["nbf"]
    token = jwt.encode(claims, signing_key, algorithm="ES256", headers={"kid": kid})

    user = verifier.verify(token)

    assert user == AuthenticatedUser(user_id=UUID(SUBJECT))


def test_verifies_an_rs256_token():
    kid = "rsa-key"
    rsa_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    verifier = _verifier(
        lambda _request: httpx.Response(200, json={"keys": [_jwk(rsa_key, kid, "RS256")]})
    )

    user = verifier.verify(_token(rsa_key, kid, "RS256"))

    assert user.user_id == UUID(SUBJECT)


def test_rejects_a_token_with_a_wrong_signature(signing_key):
    kid = "test-key"
    other_key = ec.generate_private_key(ec.SECP256R1())
    verifier = _verifier(
        lambda _request: httpx.Response(200, json={"keys": [_jwk(signing_key, kid, "ES256")]})
    )

    with pytest.raises(SupabaseTokenError):
        verifier.verify(_token(other_key, kid, "ES256"))


@pytest.mark.parametrize("algorithm", ["HS256", "none"])
def test_rejects_algorithms_other_than_es256_or_rs256(signing_key, algorithm):
    kid = "test-key"
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"keys": [_jwk(signing_key, kid, "ES256")]})

    verifier = _verifier(handler)
    key = "untrusted-shared-secret-with-at-least-thirty-two-bytes" if algorithm == "HS256" else ""
    token = jwt.encode(_claims(), key, algorithm=algorithm, headers={"kid": kid})

    with pytest.raises(SupabaseTokenError):
        verifier.verify(token)

    assert calls == 0


@pytest.mark.parametrize(
    "changes",
    [
        {"iss": "https://wrong-project.supabase.co/auth/v1"},
        {"aud": "anon"},
        {"role": "anon"},
        {"exp": int(datetime.now(UTC).timestamp()) - 1},
        {"nbf": int(datetime.now(UTC).timestamp()) + 300},
    ],
    ids=["issuer", "audience", "role", "expired", "not-before"],
)
def test_rejects_invalid_registered_or_role_claims(signing_key, changes):
    kid = "test-key"
    verifier = _verifier(
        lambda _request: httpx.Response(200, json={"keys": [_jwk(signing_key, kid, "ES256")]})
    )

    with pytest.raises(SupabaseTokenError):
        verifier.verify(_token(signing_key, kid, "ES256", **changes))


@pytest.mark.parametrize("claim", ["exp", "iat", "iss", "aud", "sub", "role"])
def test_rejects_each_missing_required_claim(signing_key, claim):
    kid = "test-key"
    claims = _claims()
    del claims[claim]
    verifier = _verifier(
        lambda _request: httpx.Response(200, json={"keys": [_jwk(signing_key, kid, "ES256")]})
    )
    token = jwt.encode(claims, signing_key, algorithm="ES256", headers={"kid": kid})

    with pytest.raises(SupabaseTokenError):
        verifier.verify(token)


@pytest.mark.parametrize("subject", ["not-a-uuid", "", "11111111111111111111111111111111x", None])
def test_rejects_an_invalid_uuid_subject(signing_key, subject):
    kid = "test-key"
    verifier = _verifier(
        lambda _request: httpx.Response(200, json={"keys": [_jwk(signing_key, kid, "ES256")]})
    )

    with pytest.raises(SupabaseTokenError):
        verifier.verify(_token(signing_key, kid, "ES256", sub=subject))


def test_rejects_an_unavailable_jwks(signing_key):
    verifier = _verifier(lambda _request: httpx.Response(503))

    with pytest.raises(SupabaseTokenError):
        verifier.verify(_token(signing_key, "test-key", "ES256"))


def test_reuses_cached_jwks_for_a_known_kid(signing_key):
    kid = "test-key"
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(200, json={"keys": [_jwk(signing_key, kid, "ES256")]})

    verifier = _verifier(handler)
    token = _token(signing_key, kid, "ES256")

    verifier.verify(token)
    verifier.verify(token)

    assert calls == 1


def test_refreshes_jwks_once_for_an_unknown_kid(signing_key):
    first_kid = "first-key"
    rotated_kid = "rotated-key"
    rotated_key = ec.generate_private_key(ec.SECP256R1())
    responses = [
        {"keys": [_jwk(signing_key, first_kid, "ES256")]},
        {"keys": [_jwk(rotated_key, rotated_kid, "ES256")]},
    ]
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        response = httpx.Response(200, json=responses[calls])
        calls += 1
        return response

    verifier = _verifier(handler)

    verifier.verify(_token(signing_key, first_kid, "ES256"))
    user = verifier.verify(_token(rotated_key, rotated_kid, "ES256"))

    assert user.user_id == UUID(SUBJECT)
    assert calls == 2


def test_refreshes_expired_jwks_cache_after_ten_minutes(signing_key):
    kid = "rotating-key"
    rotated_key = ec.generate_private_key(ec.SECP256R1())
    now = 0.0
    responses = [
        {"keys": [_jwk(signing_key, kid, "ES256")]},
        {"keys": [_jwk(rotated_key, kid, "ES256")]},
    ]
    calls = 0

    def clock() -> float:
        return now

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        response = httpx.Response(200, json=responses[calls])
        calls += 1
        return response

    verifier = _verifier(handler, clock=clock)
    verifier.verify(_token(signing_key, kid, "ES256"))
    now = 599.0
    verifier.verify(_token(signing_key, kid, "ES256"))
    now = 600.0
    user = verifier.verify(_token(rotated_key, kid, "ES256"))

    assert user.user_id == UUID(SUBJECT)
    assert calls == 2
