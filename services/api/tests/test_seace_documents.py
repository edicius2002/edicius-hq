import httpx
from fastapi.testclient import TestClient

from app.main import app
from app.routers import seace_documents

client = TestClient(app)
PDF_URL = "https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/153221571"
PDF = b"%PDF-1.7\nexample"


def test_preview_serves_upstream_attachment_inline(monkeypatch):
    def answer(request):
        assert str(request.url) == PDF_URL
        return httpx.Response(
            200,
            content=PDF,
            headers={
                "content-type": "application/pdf",
                "content-disposition": 'attachment; filename="contract.pdf"',
            },
        )

    monkeypatch.setattr(
        seace_documents,
        "document_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(answer)),
    )
    response = client.get("/api/seace/document", params={"url": PDF_URL})

    assert response.status_code == 200
    assert response.content == PDF
    assert response.headers["content-type"] == "application/pdf"
    assert response.headers["content-disposition"] == "inline"


def test_preview_rejects_urls_outside_known_public_document_paths(monkeypatch):
    def unexpected(_request):
        raise AssertionError("unsafe URL reached the network")

    monkeypatch.setattr(
        seace_documents,
        "document_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(unexpected)),
    )
    for url in (
        "http://prod4.seace.gob.pe:9000/api/con/documentos/descargar/1",
        "https://prod4.seace.gob.pe.evil.test:9000/api/con/documentos/descargar/1",
        "https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/1/../../admin",
        "https://prod4.seace.gob.pe:9000/api/bus/contrato/idContrato/1",
    ):
        assert client.get("/api/seace/document", params={"url": url}).status_code == 400


def test_preview_rejects_non_pdf_response(monkeypatch):
    monkeypatch.setattr(
        seace_documents,
        "document_client",
        lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(200, content=b"<html>error</html>")
            )
        ),
    )

    assert client.get("/api/seace/document", params={"url": PDF_URL}).status_code == 502


def test_preview_uses_public_search_headers_for_notice_documents(monkeypatch):
    url = (
        "https://prod6.seace.gob.pe/v1/s8uit-services/archivo/archivos-publico/"
        "descargar-archivo-contrato/12345"
    )

    def answer(request):
        if (
            not request.headers.get("user-agent", "").startswith("Mozilla/5.0")
            or request.headers.get("accept") != "application/json, text/plain, */*"
            or request.headers.get("accept-language") != "es-PE,es;q=0.9"
            or request.headers.get("referer") != "https://prod6.seace.gob.pe/buscador-publico/"
        ):
            return httpx.Response(403)
        return httpx.Response(200, content=PDF)

    monkeypatch.setattr(
        seace_documents,
        "document_client",
        lambda: httpx.AsyncClient(transport=httpx.MockTransport(answer)),
    )

    response = client.get("/api/seace/document", params={"url": url})
    assert response.status_code == 200
    assert response.content == PDF


def test_preview_stops_a_document_that_exceeds_the_size_limit(monkeypatch):
    monkeypatch.setattr(
        seace_documents,
        "document_client",
        lambda: httpx.AsyncClient(
            transport=httpx.MockTransport(
                lambda _request: httpx.Response(
                    200, content=b"%PDF-" + b"x" * (seace_documents.MAX_PDF_BYTES + 1)
                )
            )
        ),
    )

    assert client.get("/api/seace/document", params={"url": PDF_URL}).status_code == 413
