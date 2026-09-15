"""The only Airfare boundary that speaks to the Supabase Data API."""

import re
from collections.abc import Mapping, Sequence
from typing import Any
from urllib.parse import urlsplit

import httpx

from app.config import airfare_supabase_config


class AirfareRemoteError(RuntimeError):
    """A sanitized Supabase Data API failure."""


class AirfareRemoteUnavailable(AirfareRemoteError):
    """A retryable network, rate-limit, or server failure."""


class AirfareRemoteRejected(AirfareRemoteError):
    """A non-retryable request, schema, or response failure."""


_PROJECT_HOST = re.compile(r"^[a-z0-9]+\.supabase\.co$")
_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")
_CONFLICT_TARGET = re.compile(r"^[a-z_][a-z0-9_,]*$")
_SECRET_VALUE = re.compile(r"\bsb_(?:secret|publishable)_[A-Za-z0-9_-]+\b")
_SENSITIVE_VALUE = re.compile(
    r"(?i)\b(apikey|authorization|token|secret|password|key)\b\s*([=:])\s*[^\s,;}&]+"
)
_SENSITIVE_JSON_VALUE = re.compile(
    r'(?i)(["\']?(?:apikey|authorization|token|secret|password|key)["\']?\s*:\s*)'
    r'("(?:\\.|[^"\\])*"|\'(?:\\.|[^\'\\])*\'|[^,}\s]+)'
)
_URL = re.compile(r"https?://[^\s,;]+")
_MAX_ERROR_EXCERPT = 200


def _project_url(url: str) -> str:
    parsed = urlsplit(url)
    if (
        parsed.scheme != "https"
        or not parsed.hostname
        or not _PROJECT_HOST.fullmatch(parsed.hostname)
        or parsed.username is not None
        or parsed.password is not None
        or parsed.port is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("Supabase URL must be an HTTPS project host")
    return url.rstrip("/")


def _identifier(value: str, *, kind: str) -> str:
    if not _IDENTIFIER.fullmatch(value):
        raise ValueError(f"invalid Supabase {kind}")
    return value


def _response_excerpt(response: httpx.Response) -> str:
    """Keep useful schema diagnostics while removing credentials and destinations."""
    excerpt = response.text[:_MAX_ERROR_EXCERPT]
    excerpt = _URL.sub("[redacted-url]", excerpt)
    excerpt = _SECRET_VALUE.sub("[redacted]", excerpt)
    excerpt = _SENSITIVE_JSON_VALUE.sub(r'\1"[redacted]"', excerpt)
    excerpt = _SENSITIVE_VALUE.sub(
        lambda match: f"{match.group(1)}{match.group(2)}[redacted]", excerpt
    )
    return excerpt


class SupabaseAirfare:
    """A lifecycle-managed, server-only PostgREST client for Airfare data."""

    def __init__(
        self,
        url: str,
        secret_key: str,
        *,
        timeout_seconds: float = 15.0,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        project_url = _project_url(url)
        if not secret_key:
            raise ValueError("Supabase secret key must not be empty")
        if timeout_seconds <= 0:
            raise ValueError("Supabase timeout must be positive")
        self._project_host = urlsplit(project_url).hostname
        self._client = httpx.Client(
            base_url=f"{project_url}/rest/v1/",
            headers={
                "apikey": secret_key,
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            timeout=timeout_seconds,
            transport=transport,
            follow_redirects=False,
        )

    @property
    def is_closed(self) -> bool:
        return self._client.is_closed

    def upsert(
        self,
        table: str,
        rows: Sequence[Mapping[str, object]],
        *,
        on_conflict: str,
    ) -> Any:
        table = _identifier(table, kind="table")
        if not _CONFLICT_TARGET.fullmatch(on_conflict):
            raise ValueError("invalid Supabase conflict target")
        return self._post(
            table,
            list(rows),
            params={"on_conflict": on_conflict},
            headers={"Prefer": "resolution=merge-duplicates"},
        )

    def rpc(self, name: str, params: Mapping[str, object]) -> Any:
        name = _identifier(name, kind="RPC name")
        return self._post(f"rpc/{name}", dict(params))

    def _post(
        self,
        path: str,
        body: object,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        try:
            response = self._client.post(path, params=params, json=body, headers=headers)
        except (httpx.TimeoutException, httpx.RequestError) as exc:
            raise AirfareRemoteUnavailable("Supabase request is unavailable") from exc

        if 300 <= response.status_code < 400:
            location = response.headers.get("location")
            if (
                location is not None
                and urlsplit(str(response.url.join(location))).hostname != self._project_host
            ):
                raise AirfareRemoteRejected("Supabase redirected to another host")
            raise AirfareRemoteRejected("Supabase returned an unexpected redirect")
        if response.status_code == 429 or response.status_code >= 500:
            raise AirfareRemoteUnavailable(f"Supabase is unavailable ({response.status_code})")
        if response.status_code >= 400:
            excerpt = _response_excerpt(response)
            suffix = f": {excerpt}" if excerpt else ""
            raise AirfareRemoteRejected(
                f"Supabase rejected the request ({response.status_code}){suffix}"
            )
        if not response.content:
            return None
        try:
            return response.json()
        except ValueError as exc:
            raise AirfareRemoteRejected("Supabase returned invalid JSON") from exc

    def close(self) -> None:
        self._client.close()


_configured_client: SupabaseAirfare | None = None


def configured_airfare_supabase() -> SupabaseAirfare | None:
    """Create the process-wide client lazily, only for enabled cloud features."""
    global _configured_client
    config = airfare_supabase_config()
    if config is None:
        return None
    if _configured_client is None:
        _configured_client = SupabaseAirfare(
            config.url,
            config.secret_key,
            timeout_seconds=config.timeout_seconds,
        )
    return _configured_client


def close_airfare_supabase_client() -> None:
    """Release the process-wide client once FastAPI has stopped its jobs."""
    global _configured_client
    if _configured_client is not None:
        _configured_client.close()
        _configured_client = None
