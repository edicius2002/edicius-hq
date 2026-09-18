"""Contracts for the Pi's sole service-role Supabase Data API boundary."""

from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import UUID

import httpx
import pytest

from app.services.collector_cloud import (
    CollectorCloud,
    CollectorCloudRejected,
    CollectorCloudUnavailable,
    CollectorConfig,
)

OWNER_ID = UUID("11111111-1111-1111-1111-111111111111")
QUOTE = {
    "symbol": "AAPL",
    "provider": "yahoo",
    "fetched_at": "2026-09-17T00:00:00Z",
    "payload": {"price": 1},
}


@pytest.fixture
def secret_config() -> CollectorConfig:
    return CollectorConfig(
        url="https://testproject.supabase.co",
        secret_key="test-collector-secret",
        owner_id=OWNER_ID,
        timeout_seconds=2,
    )


def captured_request_for(
    operation, secret_config: CollectorConfig, response: httpx.Response | None = None
) -> httpx.Request:
    captured: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        captured.append(request)
        return response or httpx.Response(201, json=[])

    cloud = CollectorCloud(secret_config, transport=httpx.MockTransport(handle))
    operation(cloud)
    return captured[0]


def test_quote_upsert_uses_owner_symbol_conflict_and_never_authorization(secret_config):
    """Changing the conflict key or sending bearer credentials must fail this contract."""
    request = captured_request_for(lambda cloud: cloud.upsert_quotes([QUOTE]), secret_config)

    assert request.url.params["on_conflict"] == "owner_id,symbol"
    assert request.headers["apikey"] == secret_config.secret_key
    assert "authorization" not in {name.lower() for name in request.headers}
    assert json.loads(request.content) == [{**QUOTE, "owner_id": str(OWNER_ID)}]


def test_redirect_is_rejected_without_following_it(secret_config):
    """Following even a same-host redirect could replay the service secret."""
    first = httpx.Response(307, headers={"location": "/rest/v1/market_quotes"})
    with pytest.raises(CollectorCloudRejected, match="redirect"):
        captured_request_for(lambda cloud: cloud.upsert_quotes([QUOTE]), secret_config, first)


def test_remote_errors_are_sanitized(secret_config):
    """A response body or query-bearing endpoint must never surface to collectors."""
    response = httpx.Response(400, text="secret response body")
    with pytest.raises(CollectorCloudRejected) as raised:
        captured_request_for(lambda cloud: cloud.upsert_quotes([QUOTE]), secret_config, response)

    message = str(raised.value)
    assert "secret response body" not in message
    assert "testproject" not in message
    assert "test-collector-secret" not in message


def test_document_returns_none_for_a_not_found_document(secret_config):
    """A missing optional app document is distinct from an unavailable cloud."""
    response = httpx.Response(200, json=[])
    assert captured_request_for(lambda cloud: cloud.document("watchlist"), secret_config, response)

    cloud = CollectorCloud(secret_config, transport=httpx.MockTransport(lambda _: response))
    assert cloud.document("watchlist") is None


def test_claim_request_calls_the_owner_scoped_rpc_and_returns_immutable_request(secret_config):
    """Claiming must use the atomic RPC, rather than a racy table update."""
    body = {
        "request_id": "22222222-2222-2222-2222-222222222222",
        "owner_id": str(OWNER_ID),
        "operation": "market-bars",
        "payload": {"symbol": "AAPL"},
        "expires_at": "2026-09-17T00:05:00+00:00",
    }
    request = captured_request_for(
        lambda cloud: cloud.claim_request(), secret_config, httpx.Response(200, json=body)
    )
    assert request.url.path.endswith("/rpc/claim_collector_request")
    assert json.loads(request.content) == {"p_owner_id": str(OWNER_ID)}

    cloud = CollectorCloud(
        secret_config, transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))
    )
    claimed = cloud.claim_request()
    assert claimed is not None
    assert claimed.id == UUID(body["request_id"])
    assert claimed.owner_id == OWNER_ID
    assert claimed.expires_at == datetime(2026, 9, 17, 0, 5, tzinfo=UTC)
    with pytest.raises(AttributeError):
        claimed.operation = "market-search"


def test_claimed_request_payload_is_deeply_immutable(secret_config):
    """A worker must not mutate a claimed request before recording its result."""
    body = {
        "request_id": "22222222-2222-2222-2222-222222222222",
        "owner_id": str(OWNER_ID),
        "operation": "market-search",
        "payload": {"query": {"symbols": ["AAPL"]}},
        "expires_at": "2026-09-17T00:05:00+00:00",
    }
    cloud = CollectorCloud(
        secret_config, transport=httpx.MockTransport(lambda _: httpx.Response(200, json=body))
    )
    claimed = cloud.claim_request()

    assert claimed is not None
    assert claimed.payload["query"]["symbols"][0] == "AAPL"
    with pytest.raises((AttributeError, TypeError)):
        claimed.payload["query"]["symbols"].append("MSFT")


def test_run_transitions_are_compare_and_set(secret_config):
    """A retry must not finish or fail a run that is no longer running."""
    run_id = "33333333-3333-3333-3333-333333333333"
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            return httpx.Response(201, json=[{"run_id": run_id}])
        return httpx.Response(204)

    cloud = CollectorCloud(secret_config, transport=httpx.MockTransport(handle))
    assert cloud.begin_run("market") == UUID(run_id)
    cloud.finish_run(UUID(run_id), {"seen": 3, "written": 2, "failed": 1})
    cloud.fail_run(UUID(run_id), "provider_unavailable")

    assert requests[1].url.params["status"] == "eq.running"
    assert requests[1].url.params["run_id"] == f"eq.{run_id}"
    completed = json.loads(requests[1].content)
    assert {key: value for key, value in completed.items() if key != "completed_at"} == {
        "status": "complete",
        "records_seen": 3,
        "records_written": 2,
        "records_failed": 1,
    }
    assert requests[2].url.params["status"] == "eq.running"
    failed = json.loads(requests[2].content)
    assert {key: value for key, value in failed.items() if key != "completed_at"} == {
        "status": "failed",
        "error_code": "provider_unavailable",
    }
    for transition in (completed, failed):
        timestamp = transition["completed_at"]
        assert datetime.fromisoformat(timestamp).tzinfo == UTC


def test_invalid_request_result_is_rejected_without_payload_details(secret_config):
    """Malformed caller results must not escape raw mapping-conversion exceptions."""
    cloud = CollectorCloud(
        secret_config, transport=httpx.MockTransport(lambda _: httpx.Response(200))
    )
    with pytest.raises(CollectorCloudRejected) as raised:
        cloud.complete_request(UUID("33333333-3333-3333-3333-333333333333"), None)  # type: ignore[arg-type]

    assert "None" not in str(raised.value)


def test_network_failure_is_unavailable_without_request_details(secret_config):
    """Transport failures are retryable but never disclose credential-bearing context."""

    def fail(_: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("test-collector-secret")

    cloud = CollectorCloud(secret_config, transport=httpx.MockTransport(fail))
    with pytest.raises(CollectorCloudUnavailable) as raised:
        cloud.upsert_quotes([QUOTE])
    assert "test-collector-secret" not in str(raised.value)
