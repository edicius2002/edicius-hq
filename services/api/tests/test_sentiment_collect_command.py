import asyncio
import importlib.util
import json
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from types import ModuleType
from unittest.mock import Mock

from app.adapters.cnn_sentiment import (
    SentimentPayloadError,
    SentimentProviderError,
    parse_sentiment,
)
from app.services.collector_cloud import CollectorCloudUnavailable

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "sentiment-collect.py"


def load_script() -> ModuleType:
    name = f"sentiment_collect_script_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SCRIPT_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def snapshot():
    payload = json.loads(
        (Path(__file__).parent / "fixtures" / "cnn_sentiment_synthetic.json").read_text()
    )
    return parse_sentiment(payload, fetched_at=datetime(2026, 9, 18, tzinfo=UTC))


def cloud() -> Mock:
    result = Mock()
    result.owner_id = uuid.UUID("11111111-1111-1111-1111-111111111111")
    result.begin_run.return_value = uuid.UUID("22222222-2222-2222-2222-222222222222")
    return result


def run_sentiment_pass(*, fetch, cloud):
    return asyncio.run(load_script().collect_once(cloud, fetch=fetch))


async def fetch_snapshot(_client):
    return snapshot()


def test_success_writes_normalized_snapshot_and_finishes_run():
    remote = cloud()

    assert run_sentiment_pass(fetch=fetch_snapshot, cloud=remote) == 0

    remote.upsert_sentiment.assert_called_once()
    row = remote.upsert_sentiment.call_args.args[0]
    assert row["owner_id"] == str(remote.owner_id)
    assert row["payload"] == snapshot().to_wire()
    remote.finish_run.assert_called_once_with(
        remote.begin_run.return_value, {"seen": 1, "written": 1, "failed": 0}
    )


def test_provider_failure_marks_the_run_failed_without_writing_a_snapshot():
    remote = cloud()

    async def fetch(_client):
        raise SentimentProviderError("unreachable", "provider detail", transient=True)

    assert run_sentiment_pass(fetch=fetch, cloud=remote) == 1

    remote.upsert_sentiment.assert_not_called()
    remote.fail_run.assert_called_once_with(remote.begin_run.return_value, "unreachable")


def test_invalid_payload_marks_the_run_failed_without_writing_a_snapshot():
    remote = cloud()

    async def fetch(_client):
        raise SentimentPayloadError("provider detail")

    assert run_sentiment_pass(fetch=fetch, cloud=remote) == 1

    remote.upsert_sentiment.assert_not_called()
    remote.fail_run.assert_called_once_with(remote.begin_run.return_value, "invalid-payload")


def test_cloud_upsert_failure_marks_the_run_failed_without_overwriting_prior_snapshot():
    remote = cloud()
    remote.upsert_sentiment.side_effect = CollectorCloudUnavailable("cloud detail")

    assert run_sentiment_pass(fetch=fetch_snapshot, cloud=remote) == 1

    remote.upsert_sentiment.assert_called_once()
    remote.fail_run.assert_called_once_with(remote.begin_run.return_value, "cloud-upsert-failed")


def test_finish_failure_is_nonzero_and_marks_the_run_failed():
    remote = cloud()
    remote.finish_run.side_effect = CollectorCloudUnavailable("cloud detail")

    assert run_sentiment_pass(fetch=fetch_snapshot, cloud=remote) == 1

    remote.fail_run.assert_called_once_with(remote.begin_run.return_value, "cloud-upsert-failed")


def test_begin_run_failure_is_nonzero_and_does_not_claim_success():
    remote = cloud()
    remote.begin_run.side_effect = CollectorCloudUnavailable("cloud detail")

    assert run_sentiment_pass(fetch=fetch_snapshot, cloud=remote) == 1

    remote.upsert_sentiment.assert_not_called()
    remote.finish_run.assert_not_called()
    remote.fail_run.assert_not_called()
