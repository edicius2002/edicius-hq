from fastapi.testclient import TestClient

from app.main import app

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
