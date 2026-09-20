from __future__ import annotations

import importlib.util
import sys
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "smoke-collector.py"
OWNER = "11111111-1111-1111-1111-111111111111"
CUTOFF = datetime(2026, 9, 18, tzinfo=UTC)


def load_script() -> ModuleType:
    spec = importlib.util.spec_from_file_location("pi_smoke_collector", SCRIPT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_x_state_requires_post_cutoff_completed_run_and_owner_posts() -> None:
    module = load_script()
    runs = [
        {
            "owner_id": OWNER,
            "status": "complete",
            "heartbeat_at": "2026-09-18T00:01:00+00:00",
        }
    ]

    assert module.validate_x_state(OWNER, CUTOFF, runs, [{"post_id": "42"}]) == {
        "runs": 1,
        "posts": 1,
    }
    with pytest.raises(ValueError, match="post"):
        module.validate_x_state(OWNER, CUTOFF, runs, [])


def test_market_state_requires_two_owner_results_and_fresh_quote() -> None:
    module = load_script()
    requests = [
        {
            "owner_id": OWNER,
            "operation": "market-bars",
            "status": "complete",
            "result": {"bars": [{"time": 1}]},
        },
        {
            "owner_id": OWNER,
            "operation": "market-search",
            "status": "complete",
            "result": {"results": [{"symbol": "AAPL"}]},
        },
    ]
    quotes = [{"symbol": "AAPL", "fetched_at": "2026-09-18T00:01:00+00:00"}]

    assert module.validate_market_state(OWNER, CUTOFF, requests, quotes) == {
        "requests": 2,
        "quotes": 1,
    }
    requests[0]["owner_id"] = "22222222-2222-2222-2222-222222222222"
    with pytest.raises(ValueError, match="owner"):
        module.validate_market_state(OWNER, CUTOFF, requests, quotes)


def test_market_state_rejects_empty_or_stale_provider_results() -> None:
    module = load_script()
    requests = [
        {
            "owner_id": OWNER,
            "operation": "market-bars",
            "status": "complete",
            "result": {"bars": []},
        },
        {
            "owner_id": OWNER,
            "operation": "market-search",
            "status": "complete",
            "result": {"results": []},
        },
    ]
    with pytest.raises(ValueError, match="result"):
        module.validate_market_state(
            OWNER,
            CUTOFF,
            requests,
            [{"symbol": "AAPL", "fetched_at": "2026-09-17T23:59:00+00:00"}],
        )


def test_airfare_request_worker_smoke_requires_a_post_cutoff_run() -> None:
    module = load_script()
    runs = [
        {
            "owner_id": OWNER,
            "status": "complete",
            "heartbeat_at": "2026-09-18T00:01:00+00:00",
        }
    ]

    assert module.validate_airfare_requests_state(OWNER, CUTOFF, runs) == {"runs": 1}
    runs[0]["heartbeat_at"] = "2026-09-17T23:59:00+00:00"
    with pytest.raises(ValueError, match="Airfare request worker"):
        module.validate_airfare_requests_state(OWNER, CUTOFF, runs)


def test_airfare_request_worker_smoke_uses_the_bounded_once_mode() -> None:
    text = SCRIPT.read_text(encoding="utf-8")
    assert '"airfare-requests"' in text
    assert '_run("airfare-request-worker.py")' in text


def test_smoke_uses_injected_environment_without_reopening_root_secret_file(
    monkeypatch, tmp_path
) -> None:
    module = load_script()
    module.ENV_FILE = tmp_path / "unreadable-and-absent.env"
    values = {
        "SUPABASE_URL": "https://abndifkxpfppmllgxfnu.supabase.co",
        "SUPABASE_SECRET_KEY": "test-secret",
        "EDICIUS_OWNER_ID": OWNER,
        "COLLECTOR_SUPABASE_TIMEOUT_SECONDS": "15",
        "AIRFARE_DATA_BACKEND": "supabase",
        "AIRFARE_SYNC_ENABLED": "true",
    }
    for name, value in values.items():
        monkeypatch.setenv(name, value)

    module.load_env()
