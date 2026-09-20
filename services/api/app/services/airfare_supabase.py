"""The only Airfare boundary that speaks to the Supabase Data API."""

import asyncio
import re
from collections.abc import Mapping, Sequence
from concurrent.futures import ThreadPoolExecutor
from math import isfinite
from threading import Event, RLock
from time import monotonic
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


class AirfareHistoryRevisionChanged(AirfareRemoteError):
    """Only the exact history protocol conflict can restart an assembled read."""


_PROJECT_HOST = re.compile(r"^[a-z0-9]+\.supabase\.co$")
_IDENTIFIER = re.compile(r"^[a-z_][a-z0-9_]*$")
_CONFLICT_TARGET = re.compile(r"^[a-z_][a-z0-9_,]*$")
_HISTORY_BUDGET_SECONDS = 60.0
_HISTORY_PROTOCOL_ERRORS = {
    ("22023", "airfare_history_invalid_request"),
    ("22023", "airfare_history_invalid_cursor"),
    ("22023", "airfare_history_item_too_large"),
    ("22023", "airfare_history_metadata_too_large"),
    ("55000", "airfare_history_revision_missing"),
}


def _decode_response(response: httpx.Response) -> Any:
    if response.status_code >= 400:
        try:
            error = response.json()
        except ValueError:
            error = None
        if isinstance(error, dict):
            code, message = error.get("code"), error.get("message")
            if code == "40001" and message == "airfare_history_revision_changed":
                raise AirfareHistoryRevisionChanged("Airfare history revision changed")
            if (
                isinstance(code, str)
                and isinstance(message, str)
                and (code, message) in _HISTORY_PROTOCOL_ERRORS
            ):
                raise AirfareRemoteRejected("Supabase rejected the history protocol request")
    if response.status_code == 429 or response.status_code >= 500:
        raise AirfareRemoteUnavailable(f"Supabase is unavailable ({response.status_code})")
    if response.status_code >= 400:
        raise AirfareRemoteRejected(f"Supabase rejected the request ({response.status_code})")
    if not response.content:
        return None
    try:
        return response.json()
    except ValueError:
        raise AirfareRemoteRejected("Supabase returned invalid JSON") from None


def _reject_redirect_response(response: httpx.Response) -> None:
    if 300 <= response.status_code < 400:
        raise AirfareRemoteRejected("Supabase returned an unexpected redirect")


def _project_url(url: str) -> str:
    try:
        parsed = urlsplit(url)
        hostname = parsed.hostname
        port = parsed.port
    except ValueError:
        raise ValueError("Supabase URL must be an HTTPS project host") from None
    if (
        parsed.scheme != "https"
        or not hostname
        or not _PROJECT_HOST.fullmatch(hostname)
        or parsed.username is not None
        or parsed.password is not None
        or port is not None
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


class SupabaseAirfare:
    """A lifecycle-managed, server-only PostgREST client for Airfare data."""

    def __init__(
        self,
        url: str,
        secret_key: str,
        *,
        timeout_seconds: float = 15.0,
        transport: httpx.BaseTransport | None = None,
        history_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        project_url = _project_url(url)
        if not secret_key:
            raise ValueError("Supabase secret key must not be empty")
        if not isfinite(timeout_seconds) or timeout_seconds <= 0:
            raise ValueError("Supabase timeout must be positive")
        self._project_host = urlsplit(project_url).hostname
        self._history_transport = history_transport
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
            event_hooks={"response": [_reject_redirect_response]},
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

    def read_history(
        self, params: Mapping[str, object], *, cancel_event: Event | None = None
    ) -> dict[str, Any]:
        """Return one complete revision, with an independently cancellable transport."""
        from app.services.airfare_history_pages import assemble_history

        deadline = monotonic() + _HISTORY_BUDGET_SECONDS

        def check_cancelled() -> None:
            if cancel_event is not None and cancel_event.is_set():
                raise AirfareRemoteUnavailable("Airfare history read cancelled")
            if monotonic() >= deadline:
                raise AirfareRemoteUnavailable("Airfare history deadline exceeded")

        check_cancelled()
        if self.is_closed:
            raise AirfareRemoteRejected("Supabase client is closed")

        async def read() -> dict[str, Any]:
            check_cancelled()
            try:
                async with asyncio.timeout(max(0, deadline - monotonic())):
                    async with httpx.AsyncClient(
                        base_url=self._client.base_url,
                        headers=self._client.headers,
                        timeout=self._client.timeout,
                        transport=self._history_transport,
                        follow_redirects=False,
                    ) as client:

                        async def rpc(name: str, arguments: Mapping[str, object]) -> Any:
                            check_cancelled()
                            response = await client.post(
                                f"rpc/{_identifier(name, kind='RPC name')}", json=dict(arguments)
                            )
                            check_cancelled()
                            _reject_redirect_response(response)
                            if len(response.content) > 1048576:
                                raise AirfareRemoteRejected(
                                    "Supabase history response is too large"
                                )
                            return _decode_response(response)

                        async def watch_cancel() -> None:
                            while cancel_event is None or not cancel_event.is_set():
                                await asyncio.sleep(0.02)

                        operation = asyncio.create_task(
                            assemble_history(
                                rpc,
                                params,
                                check_cancelled=check_cancelled,
                                sleep=asyncio.sleep,
                            )
                        )
                        watcher = (
                            asyncio.create_task(watch_cancel())
                            if cancel_event is not None
                            else None
                        )
                        try:
                            if watcher is not None:
                                done, _ = await asyncio.wait(
                                    {operation, watcher}, return_when=asyncio.FIRST_COMPLETED
                                )
                                if watcher in done:
                                    raise AirfareRemoteUnavailable("Airfare history read cancelled")
                            result = await operation
                            check_cancelled()
                            return result
                        finally:
                            pending = [operation] + ([watcher] if watcher is not None else [])
                            for task in pending:
                                task.cancel()
                            await asyncio.gather(*pending, return_exceptions=True)
            except (TimeoutError, httpx.TimeoutException, httpx.RequestError):
                raise AirfareRemoteUnavailable("Airfare history request is unavailable") from None

        # Async I/O lets the deadline cancel in-flight streams; a dedicated worker
        # also supports synchronous callers that already have an event loop.
        with ThreadPoolExecutor(max_workers=1, thread_name_prefix="airfare-history") as pool:
            result = pool.submit(lambda: asyncio.run(read())).result()
        check_cancelled()
        return result

    def select_all(
        self,
        table: str,
        columns: Sequence[str],
        *,
        key: str,
        page_size: int = 500,
    ) -> list[dict[str, Any]]:
        """Read replica verification fields, including server-capped pages."""
        allowed = {
            "fare_snapshots": {"record_id"},
            "fare_baseline_points": {"record_id"},
            "fare_calendar_captures": {"record_id"},
            "fare_checks": {"record_id", "kind"},
            "fare_airports": {"code", "payload"},
            "airfare_documents": {"key", "value", "source_updated_at"},
        }
        if (
            table not in allowed
            or not columns
            or not set(columns) <= allowed[table]
            or key not in columns
            or key not in {"record_id", "code", "key"}
            or isinstance(page_size, bool)
            or not 1 <= page_size <= 500
        ):
            raise ValueError("invalid Supabase verification selection")
        found: dict[str, dict[str, Any]] = {}
        offset = 0
        while True:
            page = self._request(
                "GET",
                table,
                params={
                    "select": ",".join(columns),
                    "order": f"{key}.asc",
                    "offset": str(offset),
                    "limit": str(page_size),
                },
            )
            if not isinstance(page, list) or any(
                not isinstance(row, dict)
                or not isinstance(row.get(key), str)
                or not set(columns) <= row.keys()
                for row in page
            ):
                raise AirfareRemoteRejected("Supabase returned an invalid selection")
            if not page:
                return list(found.values())
            previous = len(found)
            for row in page:
                if row[key] in found and found[row[key]] != row:
                    raise AirfareRemoteRejected("Supabase selection changed during pagination")
                found[row[key]] = row
            if len(found) == previous:
                raise AirfareRemoteRejected("Supabase selection pagination did not advance")
            offset += len(page)

    def _post(
        self,
        path: str,
        body: object,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        return self._request("POST", path, body=body, params=params, headers=headers)

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: object = None,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
    ) -> Any:
        try:
            response = self._client.request(method, path, params=params, json=body, headers=headers)
        except (httpx.TimeoutException, httpx.RequestError):
            raise AirfareRemoteUnavailable("Supabase request is unavailable") from None

        if 300 <= response.status_code < 400:
            location = response.headers.get("location")
            try:
                redirect_host = (
                    None
                    if location is None
                    else urlsplit(str(response.url.join(location))).hostname
                )
            except (ValueError, httpx.InvalidURL):
                raise AirfareRemoteRejected("Supabase returned an invalid redirect") from None
            if location is not None and redirect_host != self._project_host:
                raise AirfareRemoteRejected("Supabase redirected to another host")
            raise AirfareRemoteRejected("Supabase returned an unexpected redirect")
        return _decode_response(response)

    def close(self) -> None:
        self._client.close()


_configured_client: SupabaseAirfare | None = None
_configured_client_lock = RLock()


def configured_airfare_supabase() -> SupabaseAirfare | None:
    """Create the process-wide client lazily, only for enabled cloud features."""
    global _configured_client
    config = airfare_supabase_config()
    if config is None:
        return None
    with _configured_client_lock:
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
    with _configured_client_lock:
        if _configured_client is not None:
            _configured_client.close()
            _configured_client = None
