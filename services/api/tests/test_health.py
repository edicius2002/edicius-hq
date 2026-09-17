import httpx
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_returns_ok_without_a_jwks_network_call(monkeypatch) -> None:
    original_get = httpx.Client.get

    def refuse_hosted_jwks(client, url, *args, **kwargs):
        if str(url) == "https://abndifkxpfppmllgxfnu.supabase.co/auth/v1/.well-known/jwks.json":
            raise AssertionError("the general API test path must not fetch JWKS")
        return original_get(client, url, *args, **kwargs)

    monkeypatch.setattr(httpx.Client, "get", refuse_hosted_jwks)

    response = client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
