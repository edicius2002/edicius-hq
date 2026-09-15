import json
import threading
import traceback

import httpx
import pytest

from app.config import airfare_supabase_config
from app.services import airfare_supabase
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


@pytest.mark.parametrize("timeout", ["nan", "inf", "-inf"])
def test_configuration_rejects_non_finite_supabase_timeouts(monkeypatch, timeout):
    """Catches a cloud request timeout becoming an unbounded or invalid float."""
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-config-secret")
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "supabase")
    monkeypatch.setenv("AIRFARE_SUPABASE_TIMEOUT_SECONDS", timeout)

    with pytest.raises(ValueError, match="positive"):
        airfare_supabase_config()


def test_configuration_accepts_a_positive_fractional_supabase_timeout(monkeypatch):
    """Protects a valid sub-second cloud timeout while rejecting non-finite values."""
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-config-secret")
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "supabase")
    monkeypatch.setenv("AIRFARE_SUPABASE_TIMEOUT_SECONDS", "2.5")

    config = airfare_supabase_config()

    assert config is not None
    assert config.timeout_seconds == 2.5


def test_configuration_keeps_its_secret_out_of_repr(monkeypatch):
    """Catches routine configuration diagnostics exposing the server credential."""
    secret = "unprefixed-config-secret"
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", secret)
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "supabase")

    config = airfare_supabase_config()

    assert config is not None
    assert secret not in repr(config)


def test_configuration_parse_failures_do_not_chain_environment_values(monkeypatch):
    """Catches invalid remote settings exposing their raw process-environment value."""
    sensitive_value = "batch-size-fixture-secret"
    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-config-secret")
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "supabase")
    monkeypatch.setenv("AIRFARE_SUPABASE_BATCH_SIZE", sensitive_value)

    with pytest.raises(ValueError) as raised:
        airfare_supabase_config()

    assert sensitive_value not in "".join(traceback.format_exception(raised.value))


@pytest.mark.parametrize("timeout", [float("nan"), float("inf"), float("-inf")])
def test_adapter_rejects_non_finite_timeouts(timeout):
    """Catches direct construction bypassing the configuration timeout bound."""
    with pytest.raises(ValueError, match="positive"):
        SupabaseAirfare(
            "https://example.supabase.co", "test-direct-secret", timeout_seconds=timeout
        )


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


def test_rejected_response_omits_a_long_malformed_authorization_body():
    """Catches truncation splitting a sensitive JSON value before it is redacted."""
    sensitive_value = "Bearer fixture credential with spaces " + ("x" * 500)

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, content=f'{{"authorization":"{sensitive_value}'.encode())

    client = SupabaseAirfare(
        "https://example.supabase.co",
        "test-long-body-secret",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(AirfareRemoteRejected) as raised:
            client.rpc("read_airfare_history", {})
    finally:
        client.close()

    assert sensitive_value not in str(raised.value)
    assert "Bearer fixture" not in str(raised.value)
    assert "fixture credential with spaces" not in str(raised.value)


def test_rejected_response_omits_escaped_and_plain_configured_secrets_and_urls():
    """Catches response diagnostics reflecting credentials or real destinations."""
    secret = "unprefixed-config-secret"
    escaped_secret = "\\u0075nprefixed-config-secret"
    destination = "https://sensitive.example/path?token=fixture"

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            400,
            content=(
                '{"message":"' + escaped_secret + '","detail":"' + secret + destination + '"}'
            ).encode(),
        )

    client = SupabaseAirfare(
        "https://example.supabase.co",
        secret,
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(AirfareRemoteRejected) as raised:
            client.rpc("read_airfare_history", {})
    finally:
        client.close()

    rendered = "".join(traceback.format_exception(raised.value))
    assert secret not in rendered
    assert escaped_secret not in rendered
    assert destination not in rendered


def test_sanitized_transport_error_has_no_unsafe_exception_chain():
    """Catches normal traceback formatting exposing lower-level request diagnostics."""
    secret = "transport-fixture-secret"
    destination = "https://transport.example/path?token=fixture"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError(f"failed {destination} with {secret}", request=request)

    client = SupabaseAirfare(
        "https://example.supabase.co",
        secret,
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(AirfareRemoteUnavailable) as raised:
            client.rpc("read_airfare_history", {})
    finally:
        client.close()

    rendered = "".join(traceback.format_exception(raised.value))
    assert secret not in rendered
    assert destination not in rendered


def test_malformed_url_and_redirect_errors_are_sanitized():
    """Catches parser diagnostics escaping through configuration or redirect handling."""
    malformed_url = "https://example.supabase.co:port-with-fixture"
    with pytest.raises(ValueError) as invalid_url:
        SupabaseAirfare(malformed_url, "test-malformed-url-secret")
    assert "port-with-fixture" not in "".join(traceback.format_exception(invalid_url.value))

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": "http://[invalid-fixture"})

    client = SupabaseAirfare(
        "https://example.supabase.co",
        "test-malformed-redirect-secret",
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(AirfareRemoteRejected) as invalid_redirect:
            client.rpc("read_airfare_history", {})
    finally:
        client.close()

    assert "invalid-fixture" not in "".join(traceback.format_exception(invalid_redirect.value))


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


def test_configured_singleton_is_shared_and_closed_once_under_concurrent_callers(monkeypatch):
    """Catches concurrent lazy creation leaking all but the last HTTP client."""
    entered_constructor = threading.Event()
    release_constructor = threading.Event()
    created: list[object] = []
    results: list[object] = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            created.append(self)
            entered_constructor.set()
            assert release_constructor.wait(timeout=2)
            self.close_calls = 0

        def close(self):
            self.close_calls += 1

    monkeypatch.setenv("SUPABASE_URL", "https://example.supabase.co")
    monkeypatch.setenv("SUPABASE_SECRET_KEY", "test-singleton-secret")
    monkeypatch.setenv("AIRFARE_DATA_BACKEND", "supabase")
    monkeypatch.setattr(airfare_supabase, "SupabaseAirfare", FakeClient)
    monkeypatch.setattr(airfare_supabase, "_configured_client", None)

    first = threading.Thread(
        target=lambda: results.append(airfare_supabase.configured_airfare_supabase())
    )
    second = threading.Thread(
        target=lambda: results.append(airfare_supabase.configured_airfare_supabase())
    )
    first.start()
    assert entered_constructor.wait(timeout=2)
    second.start()
    release_constructor.set()
    first.join(timeout=2)
    second.join(timeout=2)

    assert not first.is_alive()
    assert not second.is_alive()
    assert len(created) == 1
    assert results == [created[0], created[0]]

    airfare_supabase.close_airfare_supabase_client()
    airfare_supabase.close_airfare_supabase_client()
    assert created[0].close_calls == 1
