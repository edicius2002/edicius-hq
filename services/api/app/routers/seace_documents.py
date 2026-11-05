"""Preview public SEACE PDFs without passing its attachment header to the browser."""

import re
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import Response

router = APIRouter(prefix="/api/seace", tags=["seace"])

MAX_PDF_BYTES = 20 * 1024 * 1024
CONTRACT_DOCUMENT = re.compile(r"/api/con/documentos/descargar/[0-9]+")
NOTICE_DOCUMENT = re.compile(
    r"/v1/s8uit-services/archivo/archivos-publico/descargar-archivo-contrato/[0-9]+"
)


def allowed_document_url(candidate: str) -> bool:
    try:
        url = urlsplit(candidate)
        if url.scheme != "https" or url.username or url.password or url.query or url.fragment:
            return False
        return bool(
            (
                url.hostname == "prod4.seace.gob.pe"
                and url.port == 9000
                and CONTRACT_DOCUMENT.fullmatch(url.path)
            )
            or (
                url.hostname == "prod6.seace.gob.pe"
                and url.port is None
                and NOTICE_DOCUMENT.fullmatch(url.path)
            )
        )
    except ValueError:
        return False


def document_client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=30, follow_redirects=False)


@router.get("/document")
async def preview_document(url: str = Query(...)) -> Response:
    if not allowed_document_url(url):
        raise HTTPException(400, "Unsupported SEACE document URL")

    headers = {"Accept": "application/pdf"}
    if urlsplit(url).hostname == "prod6.seace.gob.pe":
        # prod6 serves the PDF only with the public search client's request headers.
        # Keep these aligned with services/seace/vendor/seace_mcp/server.py.
        headers.update(
            {
                "User-Agent": (
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                    "AppleWebKit/537.36 (KHTML, like Gecko) "
                    "Chrome/126.0.0.0 Safari/537.36"
                ),
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "es-PE,es;q=0.9",
                "Referer": "https://prod6.seace.gob.pe/buscador-publico/",
            }
        )

    try:
        async with (
            document_client() as client,
            client.stream("GET", url, headers=headers) as upstream,
        ):
            if upstream.status_code != 200:
                raise HTTPException(502, "SEACE document unavailable")
            chunks = bytearray()
            async for chunk in upstream.aiter_bytes():
                chunks.extend(chunk)
                if len(chunks) > MAX_PDF_BYTES:
                    raise HTTPException(413, "SEACE document is too large to preview")
    except httpx.HTTPError as exc:
        raise HTTPException(502, "SEACE document unavailable") from exc

    if not chunks.startswith(b"%PDF-"):
        raise HTTPException(502, "SEACE did not return a PDF")
    return Response(
        content=bytes(chunks),
        media_type="application/pdf",
        headers={
            "Content-Disposition": "inline",
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
        },
    )
