import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import kv_store

client = TestClient(app)


def test_kv_round_trip(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))

    put = client.put("/api/kv/prefs", json={"value": {"theme": "light"}})
    assert put.status_code == 200
    assert put.json() == {"key": "prefs", "value": {"theme": "light"}}

    get = client.get("/api/kv/prefs")
    assert get.status_code == 200
    assert get.json()["value"]["theme"] == "light"

    delete = client.delete("/api/kv/prefs")
    assert delete.status_code == 204
    assert client.get("/api/kv/prefs").status_code == 404


def test_kv_rejects_unknown_key(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
    response = client.put("/api/kv/not-allowed", json={"value": 1})
    assert response.status_code == 400


class TestTheWriteIsDurable:
    """
    The stored documents are the one thing here that cannot be refetched.

    `put_value` used to be `path.write_text`: truncate, then write. Anything
    going wrong in between left the document empty or half written with no
    other copy — while the disposable bar cache, forty lines away, already
    wrote beside-then-moved so a reader would never see half a file.
    """

    def test_a_failed_write_leaves_the_previous_document_whole(self, monkeypatch, tmp_path):
        monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
        kv_store.ensure_kv_dir()
        kv_store.put_value("finance", {"diagrams": ["the real one"]})

        # Something goes wrong after the bytes are written and before they land.
        def explode(*_args, **_kwargs):
            raise OSError("disk full")

        monkeypatch.setattr(kv_store.os, "replace", explode)

        with pytest.raises(OSError):
            kv_store.put_value("finance", {"diagrams": ["the replacement"]})

        assert kv_store.get_value("finance") == {"diagrams": ["the real one"]}

    def test_a_failed_write_leaves_no_debris(self, monkeypatch, tmp_path):
        monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
        kv_store.ensure_kv_dir()
        kv_store.put_value("finance", {"a": 1})

        monkeypatch.setattr(
            kv_store.os, "replace", lambda *_a, **_k: (_ for _ in ()).throw(OSError("no"))
        )
        with pytest.raises(OSError):
            kv_store.put_value("finance", {"a": 2})

        assert list((tmp_path / "kv").glob("*.tmp")) == []

    def test_the_document_is_never_readable_as_half_a_file(self, monkeypatch, tmp_path):
        """
        A reader arriving mid-write sees the old document or the new one, never
        a truncated one. Asserted by reading at the instant the write is in
        flight: with the old `write_text` this read as empty and raised.
        """
        monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
        kv_store.ensure_kv_dir()
        kv_store.put_value("finance", {"nodes": 24})

        seen = {}
        real_replace = kv_store.os.replace

        def replace_but_look_first(src, dst):
            seen["mid_write"] = kv_store.get_value("finance")
            return real_replace(src, dst)

        monkeypatch.setattr(kv_store.os, "replace", replace_but_look_first)
        kv_store.put_value("finance", {"nodes": 25})

        assert seen["mid_write"] == {"nodes": 24}
        assert kv_store.get_value("finance") == {"nodes": 25}

    def test_it_still_round_trips_normally(self, monkeypatch, tmp_path):
        monkeypatch.setenv("LOCAL_DATA_DIR", str(tmp_path))
        kv_store.ensure_kv_dir()

        kv_store.put_value("watchlist", {"entries": [{"symbol": "AAPL"}]})

        assert kv_store.get_value("watchlist") == {"entries": [{"symbol": "AAPL"}]}
