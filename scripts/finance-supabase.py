"""Import or verify the two Finance documents without overwriting remote edits."""

import argparse
import hashlib
import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn
from urllib.parse import urlsplit
from uuid import UUID

import httpx

DOCUMENTS = {
    "finance": "finance.json",
    "finance-camera-views": "finance-camera-views.json",
}
PROJECT_URL = "https://abndifkxpfppmllgxfnu.supabase.co"


class FinanceImportError(RuntimeError):
    """A deliberately generic error safe to use in this administrative command."""


@dataclass(frozen=True)
class SourceDocument:
    key: str
    payload: dict[str, object]
    source_bytes: int
    source_sha256: str


@dataclass(frozen=True)
class RemoteDocument:
    payload: dict[str, object]
    revision: int


def canonical_json(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")


def _digest(value: object) -> str:
    return hashlib.sha256(canonical_json(value)).hexdigest()


def _owner_id(value: str) -> str:
    try:
        return str(UUID(value))
    except (AttributeError, ValueError):
        raise argparse.ArgumentTypeError("owner id must be a UUID") from None


def _reject_nonstandard_json_constant(_value: str) -> NoReturn:
    raise ValueError


def _load_documents(source: Path) -> list[SourceDocument]:
    documents: list[SourceDocument] = []
    for key, filename in DOCUMENTS.items():
        raw = (source / filename).read_bytes()
        try:
            payload = json.loads(
                raw.decode("utf-8"), parse_constant=_reject_nonstandard_json_constant
            )
            if not isinstance(payload, dict):
                raise ValueError
            source_sha256 = _digest(payload)
        except (UnicodeDecodeError, json.JSONDecodeError, ValueError):
            raise FinanceImportError(f"Finance source {filename} is invalid") from None
        documents.append(
            SourceDocument(
                key=key,
                payload=payload,
                source_bytes=len(raw),
                source_sha256=source_sha256,
            )
        )
    return documents


def _project_url(url: str | None) -> str:
    if not url:
        raise FinanceImportError("Finance Supabase configuration is unavailable")
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        raise FinanceImportError("Finance Supabase configuration is unavailable") from None
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
        raise FinanceImportError("Finance Supabase configuration is unavailable")
    return PROJECT_URL


class SupabaseFinance:
    """The small PostgREST surface required by the insert-once importer."""

    def __init__(
        self,
        url: str | None,
        secret_key: str | None,
        *,
        transport: httpx.BaseTransport | None = None,
    ) -> None:
        project_url = _project_url(url)
        if not secret_key:
            raise FinanceImportError("Finance Supabase configuration is unavailable")
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

    def select(self, owner_id: str, key: str) -> RemoteDocument | None:
        body = self._request(
            "GET",
            "finance_documents",
            params={
                "select": "payload,revision",
                "owner_id": f"eq.{owner_id}",
                "document_key": f"eq.{key}",
            },
        )
        if not isinstance(body, list) or len(body) > 1:
            raise FinanceImportError("Finance Supabase response is invalid")
        if not body:
            return None
        return self._remote_document(body[0])

    def insert(self, owner_id: str, document: SourceDocument) -> RemoteDocument:
        body = self._request(
            "POST",
            "finance_documents",
            body={
                "owner_id": owner_id,
                "document_key": document.key,
                "payload": document.payload,
                "revision": 1,
            },
            headers={"Prefer": "return=representation"},
        )
        if not isinstance(body, list) or len(body) != 1:
            raise FinanceImportError("Finance Supabase response is invalid")
        remote = self._remote_document(body[0])
        if remote.revision != 1:
            raise FinanceImportError("Finance Supabase response is invalid")
        return remote

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
            raise FinanceImportError("Finance Supabase request failed") from None
        if 300 <= response.status_code < 400:
            raise FinanceImportError("Finance Supabase returned an unexpected redirect")
        if response.status_code >= 400:
            raise FinanceImportError("Finance Supabase rejected the request")
        try:
            return response.json()
        except ValueError:
            raise FinanceImportError("Finance Supabase response is invalid") from None

    @staticmethod
    def _remote_document(value: object) -> RemoteDocument:
        if not isinstance(value, dict):
            raise FinanceImportError("Finance Supabase response is invalid")
        payload = value.get("payload")
        revision = value.get("revision")
        if (
            not isinstance(payload, dict)
            or not isinstance(revision, int)
            or isinstance(revision, bool)
            or revision < 1
        ):
            raise FinanceImportError("Finance Supabase response is invalid")
        return RemoteDocument(payload=payload, revision=revision)


def _entry(
    source: SourceDocument, destination: RemoteDocument | None, matches: bool | None
) -> dict[str, object]:
    return {
        "key": source.key,
        "sourceBytes": source.source_bytes,
        "sourceSha256": source.source_sha256,
        "destinationRevision": None if destination is None else destination.revision,
        "destinationSha256": None if destination is None else _digest(destination.payload),
        "matches": matches,
    }


def _entries(
    documents: list[SourceDocument],
    destinations: dict[str, RemoteDocument | None],
    *,
    default: bool | None,
) -> list[dict[str, object]]:
    entries: list[dict[str, object]] = []
    for document in documents:
        destination = destinations.get(document.key)
        matches = (
            default
            if destination is None
            else document.source_sha256 == _digest(destination.payload)
        )
        entries.append(_entry(document, destination, matches))
    return entries


def _validate_report_target(source: Path, report: Path) -> None:
    try:
        report_resolved = report.resolve()
        source_documents = {(source / filename).resolve() for filename in DOCUMENTS.values()}
    except OSError:
        raise FinanceImportError("Finance report target is unavailable") from None
    if report_resolved in source_documents:
        raise FinanceImportError("Finance report must not overwrite a source document")


def _write_report(path: Path, entries: list[dict[str, object]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(entries, ensure_ascii=False, separators=(",", ":"), allow_nan=False) + "\n"
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=".finance-supabase-", suffix=".tmp", dir=path.parent, text=True
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(encoded)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group(required=True)
    for action in ("dry-run", "apply", "verify"):
        actions.add_argument(f"--{action}", action="store_true")
    parser.add_argument("--owner-id", type=_owner_id, required=True)
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--report", type=Path)
    return parser


def main(
    argv: list[str] | None = None,
    *,
    environ: dict[str, str] | None = None,
    transport: httpx.BaseTransport | None = None,
) -> int:
    """Run a requested action and print only its sanitized document entries."""
    args = _parser().parse_args(argv)
    environment = os.environ if environ is None else environ
    source = args.source
    report_path = args.report
    report_target_validated = report_path is None
    entries: list[dict[str, object]] = []
    exit_code = 1
    try:
        if report_path is not None:
            _validate_report_target(source, report_path)
            report_target_validated = True
        documents = _load_documents(source)
        if args.dry_run:
            entries = [_entry(document, None, None) for document in documents]
            exit_code = 0
        else:
            client = SupabaseFinance(
                environment.get("SUPABASE_URL"),
                environment.get("SUPABASE_SECRET_KEY"),
                transport=transport,
            )
            try:
                destinations = {
                    document.key: client.select(args.owner_id, document.key)
                    for document in documents
                }
                entries = _entries(documents, destinations, default=False)
                if args.verify:
                    exit_code = 0 if all(entry["matches"] is True for entry in entries) else 1
                elif all(
                    destination is None or document.source_sha256 == _digest(destination.payload)
                    for document in documents
                    for destination in [destinations[document.key]]
                ):
                    for document in documents:
                        if destinations[document.key] is None:
                            destinations[document.key] = client.insert(args.owner_id, document)
                    entries = _entries(documents, destinations, default=False)
                    exit_code = 0
            finally:
                client.close()
    except (FinanceImportError, OSError, TypeError, ValueError):
        # The raw exception may contain a response body, URL, or secret. This
        # command deliberately uses its exit status rather than diagnostics.
        exit_code = 1
    finally:
        if report_path is not None and report_target_validated:
            _write_report(report_path, entries)
    print(json.dumps(entries, ensure_ascii=False, separators=(",", ":"), allow_nan=False))
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
