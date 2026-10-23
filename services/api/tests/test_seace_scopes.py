"""A fast notice pass must not advance the other SEACE sources."""

import asyncio
import sys
from contextlib import asynccontextmanager
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "seace"))

import incremental
import refresh


@pytest.fixture
def sources(tmp_path, monkeypatch):
    paths = tuple(
        (tmp_path / f"{kind}.js", variable, kind) for _, variable, kind in incremental.SOURCES
    )
    monkeypatch.setattr(incremental, "SOURCES", paths)
    monkeypatch.setattr(refresh, "STATE_DIR", tmp_path)
    for path, variable, _kind in paths:
        incremental.write_snapshot(
            path,
            variable,
            {
                "region": "Arequipa",
                "year": 2026,
                "fetchedAt": "2026-10-22T09:00:00-05:00",
                "records": [],
            },
        )
    return paths


@pytest.fixture
def calls(monkeypatch):
    seen = []

    class Session:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return None

        async def initialize(self):
            return None

    @asynccontextmanager
    async def stdio(*args):
        yield None, None

    async def mark(kind, *args, **kwargs):
        seen.append(kind)
        return []

    monkeypatch.setattr(incremental, "stdio_client", stdio)
    monkeypatch.setattr(incremental, "ClientSession", lambda *args: Session())
    monkeypatch.setattr(
        incremental, "minor_notice_updates", lambda *args, **kwargs: mark("notices")
    )
    monkeypatch.setattr(incremental, "process_updates", lambda *args, **kwargs: mark("processes"))
    monkeypatch.setattr(incremental, "contract_updates", lambda *args, **kwargs: mark("contracts"))
    return seen


@pytest.mark.parametrize(
    "selected,expected",
    [
        (("notices",), ["notices"]),
        (("processes", "contracts"), ["processes", "contracts"]),
    ],
)
def test_scope_fetches_publishes_and_checkpoints_only_selected_sources(
    sources, calls, selected, expected
):
    before = {kind: path.read_bytes() for path, _, kind in sources}
    published = []

    def publish(kind, rows, fetched_at, total):
        published.append(kind)

    counts = asyncio.run(
        incremental.refresh_region("Arequipa", 2026, kinds=selected, publisher=publish)
    )

    assert calls == expected
    assert published == expected
    assert list(counts) == expected
    for path, _, kind in sources:
        assert (path.read_bytes() != before[kind]) == (kind in expected)


def test_notice_only_failure_leaves_all_checkpoints_unchanged(sources, calls, monkeypatch):
    before = {kind: path.read_bytes() for path, _, kind in sources}

    async def failed(*args, **kwargs):
        raise RuntimeError("notice source failed")

    monkeypatch.setattr(incremental, "minor_notice_updates", failed)
    with pytest.raises(RuntimeError, match="notice source failed"):
        asyncio.run(incremental.refresh_region("Arequipa", 2026, kinds=("notices",)))
    for path, _, kind in sources:
        assert path.read_bytes() == before[kind]


def test_scope_rejects_unknown_or_empty_sources(sources):
    for selected in ((), ("notices", "unknown")):
        with pytest.raises(ValueError, match="source"):
            asyncio.run(incremental.refresh_region("Arequipa", 2026, kinds=selected))
