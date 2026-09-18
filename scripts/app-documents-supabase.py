"""Import local KV owner documents into Supabase without overwriting remote rows."""

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit
from uuid import UUID

import httpx

from app.config import ALLOWED_KV_KEYS

PROJECT_URL = "https://abndifkxpfppmllgxfnu.supabase.co"


class AppDocumentsImportError(RuntimeError):
    """A deliberately payload-free importer failure."""


@dataclass(frozen=True)
class SourceDocument:
    key: str
    payload: object
    source_bytes: int


def _owner_id(value: str) -> str:
    try:
        return str(UUID(value))
    except (AttributeError, ValueError):
        raise argparse.ArgumentTypeError("owner id must be a UUID") from None


def _reject_nonstandard_json_constant(_value: str) -> None:
    raise ValueError


def _load_documents(kv_dir: Path) -> list[SourceDocument]:
    try:
        paths = sorted(kv_dir.glob("*.json"))
    except OSError:
        raise AppDocumentsImportError("Local KV source is unavailable") from None

    unknown = [path.name for path in paths if path.stem not in ALLOWED_KV_KEYS]
    if unknown:
        raise AppDocumentsImportError(f"Unknown local KV document: {unknown[0]}")

    documents: list[SourceDocument] = []
    for path in paths:
        try:
            raw = path.read_bytes()
            payload = json.loads(
                raw.decode("utf-8"), parse_constant=_reject_nonstandard_json_constant
            )
        except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise AppDocumentsImportError(f"Local KV document is invalid: {path.name}") from None
        documents.append(SourceDocument(key=path.stem, payload=payload, source_bytes=len(raw)))
    return documents


def _project_url(url: str | None) -> str:
    if not url:
        raise AppDocumentsImportError("Supabase configuration is unavailable")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise AppDocumentsImportError("Supabase configuration is unavailable") from None
    expected = urlsplit(PROJECT_URL)
    if (
        parsed.scheme != "https"
        or parsed.hostname != expected.hostname
        or port is not None
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise AppDocumentsImportError("Supabase configuration is unavailable")
    return PROJECT_URL


class SupabaseAppDocuments:
    def __init__(
        self,
        url: str | None,
        secret_key: str | None,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        project_url = _project_url(url)
        if not secret_key:
            raise AppDocumentsImportError("Supabase configuration is unavailable")
        self._client = httpx.Client(
            base_url=f"{project_url}/rest/v1/",
            headers={
                "apikey": secret_key,
                "Authorization": f"Bearer {secret_key}",
                "Accept": "application/json",
                "Content-Type": "application/json",
            },
            follow_redirects=False,
            transport=transport,
            timeout=15.0,
        )

    def close(self) -> None:
        self._client.close()

    def exists(self, owner_id: str, key: str) -> bool:
        body = self._request(
            "GET",
            "app_documents",
            params={"select": "document_key", "owner_id": f"eq.{owner_id}", "document_key": f"eq.{key}"},
        )
        if not isinstance(body, list) or len(body) > 1:
            raise AppDocumentsImportError("Supabase response is invalid")
        return bool(body)

    def insert_if_absent(self, owner_id: str, document: SourceDocument) -> None:
        if self.exists(owner_id, document.key):
            return
        body = self._request(
            "POST",
            "app_documents",
            body={
                "owner_id": owner_id,
                "document_key": document.key,
                "payload": document.payload,
                "revision": 1,
            },
            headers={"Prefer": "return=minimal"},
        )
        if body is not None:
            raise AppDocumentsImportError("Supabase response is invalid")

    def _request(
        self,
        method: str,
        path: str,
        *,
        body: object = None,
        params: dict[str, str] | None = None,
        headers: dict[str, str] | None = None,
    ) -> object:
        try:
            response = self._client.request(method, path, json=body, params=params, headers=headers)
        except httpx.HTTPError:
            raise AppDocumentsImportError("Supabase request failed") from None
        if 300 <= response.status_code < 400:
            raise AppDocumentsImportError("Supabase returned an unexpected redirect")
        if response.status_code >= 400:
            raise AppDocumentsImportError("Supabase rejected the request")
        if response.status_code == 204:
            return None
        try:
            return response.json()
        except ValueError:
            raise AppDocumentsImportError("Supabase response is invalid") from None


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--owner-id", type=_owner_id, required=True)
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--source", type=Path, default=Path(".local-data") / "kv")
    return parser


def main(
    argv: list[str] | None = None,
    *,
    environ: dict[str, str] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> int:
    """Print a payload-free manifest; apply only inserts missing documents."""
    args = _parser().parse_args(argv)
    environment = os.environ if environ is None else environ
    try:
        documents = _load_documents(args.source)
        entries = [{"key": document.key, "sourceBytes": document.source_bytes} for document in documents]
        if args.apply:
            client = SupabaseAppDocuments(
                environment.get("SUPABASE_URL"), environment.get("SUPABASE_SECRET_KEY"), transport=transport
            )
            try:
                for document in documents:
                    client.insert_if_absent(args.owner_id, document)
            finally:
                client.close()
    except AppDocumentsImportError as error:
        print(str(error), file=sys.stderr)
        return 1
    print(json.dumps(entries, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
