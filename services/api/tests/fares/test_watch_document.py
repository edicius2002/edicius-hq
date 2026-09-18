import json
from pathlib import Path
from unittest.mock import Mock

import pytest

from app.services.collector_cloud import CollectorCloudUnavailable
from app.services.watch_document import CloudWatchDocument, InvalidWatchDocument

ROUTES = {
    "routes": [{"origin": "AQP", "destination": "LIM", "months": ["2026-10"], "currency": "USD"}]
}


def write_watch(path: Path, document: dict[str, object]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


def read_json(path: Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


@pytest.fixture
def cloud() -> Mock:
    return Mock()


def test_unavailable_cloud_uses_valid_cached_watch(tmp_path: Path, cloud: Mock) -> None:
    cached = write_watch(tmp_path / "kv/airfare-routes.json", ROUTES)
    cloud.document.side_effect = CollectorCloudUnavailable("unavailable")

    assert CloudWatchDocument(cloud, cached).load() == ROUTES


def test_invalid_remote_does_not_replace_cache(tmp_path: Path, cloud: Mock) -> None:
    cached = write_watch(tmp_path / "kv/airfare-routes.json", ROUTES)
    cloud.document.return_value = {"routes": "wrong"}

    with pytest.raises(InvalidWatchDocument):
        CloudWatchDocument(cloud, cached).load()

    assert read_json(cached) == ROUTES
