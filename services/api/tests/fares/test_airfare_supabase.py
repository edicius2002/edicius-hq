import json

import httpx
import pytest

from app.config import airfare_supabase_config
from app.services.airfare_supabase import (
    AirfareRemoteRejected,
    AirfareRemoteUnavailable,
    SupabaseAirfare,
)

SNAPSHOT_ROW = {
    "record_id": "a" * 64,
    "origin": "AQP",
    "destination": "LIM",
    "payload": {"flightDate": "2027-03-01"},
}


def test_local_airfare_configuration_does_not_require_supabase_secrets(monkeypatch):
    """Catches local rollback startup beginning to require remote credentials."""
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "local")
    monkeypatch.setenv("AIRFARE_SYNC_ENABLED", "false")

    assert airfare_supabase_config() is None


@pytest.mark.parametrize(
    ("name", "value", "message"),
    [
        ("AIRFARE_DATA_BACKEND", "postgres", "AIRFARE_DATA_BACKEND"),
        ("AIRFARE_SUPABASE_TIMEOUT_SECONDS", "0", "positive"),
        ("AIRFARE_SUPABASE_BATCH_SIZE", "501", "1 and 500"),
    ],
)
def test_invalid_airfare_supabase_configuration_is_rejected(monkeypatch, name, value, message):
    """Catches a malformed cloud configuration becoming a surprising default."""
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "sb_secret_example")
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "supabase")
    monkeypatch.setenv(name, value)

    with pytest.raises(ValueError, match=message):
        airfare_supabase_config()


@pytest.mark.parametrize(
    ("backend", "sync_enabled"),
    [("supabase", "false"), ("local", "true")],
)
def test_cloud_airfare_features_require_both_configuration_variables(
    monkeypatch, backend, sync_enabled
):
    """Catches remote reads or sync proceeding without the credentials they need."""
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_SECRET_KEY", raising=False)
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", backend)
    monkeypatch.setenv("AIRFARE_SYNC_ENABLED", sync_enabled)

    with pytest.raises(ValueError, match="SUPABASE_URL, SUPABASE_SECRET_KEY"):
        airfare_supabase_config()


def test_secret_uses_only_apikey_header():
    """Catches a server secret being sent as a Bearer credential."""
    seen: dict[str, str] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json=[])

    client = SupabaseAirfare(
        "https://example.supabase.co",
        "sb_secret_example",
        transport=httpx.MockTransport(handler),
    )
    try:
        client.upsert("fare_snapshots", [SNAPSHOT_ROW], on_conflict="record_id")
    finally:
        client.close()

    assert seen["apikey"] == "sb_secret_example"
    assert "authorization" not in seen


@pytest.mark.parametrize(
    "url",
    [
        "http://example.supabase.co",
        "https://example.invalid",
        "https://example.supabase.co/rest/v1",
    ],
)
def test_adapter_rejects_non_project_https_urls(url):
    """Catches credentials being pointed at a non-Supabase or derived endpoint."""
    with pytest.raises(ValueError, match="Supabase URL"):
        SupabaseAirfare(url, "sb_secret_example")


def test_upsert_posts_json_rows_with_merge_resolution_and_conflict_target():
    """Catches sync rows being serialized outside the idempotent PostgREST contract."""
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["query"] = dict(request.url.params)
        seen["headers"] = dict(request.headers)
        seen["json"] = json.loads(request.content)
        return httpx.Response(201, json=[SNAPSHOT_ROW])

    client = SupabaseAirfare(
        "https://example.supabase.co",
        "sb_secret_example",
        transport=httpx.MockTransport(handler),
    )
    try:
        assert client.upsert("fare_snapshots", [SNAPSHOT_ROW], on_conflict="record_id") == [
            SNAPSHOT_ROW
        ]
    finally:
        client.close()

    assert seen["path"] == "/rest/v1/fare_snapshots"
    assert seen["query"] == {"on_conflict": "record_id"}
    headers = seen["headers"]
    assert isinstance(headers, dict)
    assert headers["prefer"] == "resolution=merge-duplicates"
    assert headers["content-type"] == "application/json"
    assert headers["accept"] == "application/json"
    assert seen["json"] == [SNAPSHOT_ROW]


def test_rpc_posts_its_parameter_object_to_the_rpc_path():
    """Catches callers accidentally needing to know a PostgREST request shape."""
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["path"] = request.url.path
        seen["json"] = json.loads(request.content)
        return httpx.Response(200, json={"snapshots": []})

    client = SupabaseAirfare(
        "https://example.supabase.co",
        "sb_secret_example",
        transport=httpx.MockTransport(handler),
    )
    try:
        assert client.rpc("read_airfare_history", {"p_origin": "AQP"}) == {"snapshots": []}
    finally:
        client.close()

    assert seen == {"path": "/rest/v1/rpc/read_airfare_history", "json": {"p_origin": "AQP"}}


@pytest.mark.parametrize(
    "failure",
    [
        httpx.ReadTimeout("slow upstream"),
        httpx.Response(429, text="rate limited"),
        httpx.Response(503, text="unavailable"),
    ],
)
def test_transient_remote_failures_are_typed_as_unavailable(failure):
    """Catches outages being mistaken for permanent schema or payload failures."""

    def handler(request: httpx.Request) -> httpx.Response:
        if isinstance(failure, Exception):
            raise failure
        return failure

    client = SupabaseAirfare(
        "https://example.supabase.co",
        "sb_secret_example",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(AirfareRemoteUnavailable):
            client.rpc("read_airfare_history", {})
    finally:
        client.close()


def test_permanent_response_is_rejected_with_a_bounded_redacted_excerpt():
    """Catches schema errors leaking headers, URLs, or a server-provided secret."""
    secret = "raw-response-credential"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            json={"message": "schema mismatch", "apikey": secret, "detail": "x" * 600},
            headers={"x-secret": secret},
        )

    client = SupabaseAirfare(
        "https://example.supabase.co",
        "sb_secret_example",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(AirfareRemoteRejected) as raised:
            client.rpc("read_airfare_history", {})
    finally:
        client.close()

    message = str(raised.value)
    assert "400" in message
    assert secret not in message
    assert "x-secret" not in message
    assert "example.supabase.co" not in message
    assert len(message) < 350


def test_cross_host_redirect_is_rejected_without_disclosing_its_location():
    """Catches a redirect exfiltrating the server credential to another host."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "https://evil.example/path?key=secret"})

    client = SupabaseAirfare(
        "https://example.supabase.co",
        "sb_secret_example",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(AirfareRemoteRejected) as raised:
            client.rpc("read_airfare_history", {})
    finally:
        client.close()

    assert "evil.example" not in str(raised.value)


def test_close_releases_the_reusable_http_client():
    """Catches a long-lived process retaining the adapter's HTTP resources."""
    client = SupabaseAirfare("https://example.supabase.co", "sb_secret_example")
    client.close()

    assert client.is_closed
