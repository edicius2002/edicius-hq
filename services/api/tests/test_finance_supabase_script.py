"""The administrative Finance import must never overwrite a remote document."""

import hashlib
import importlib.util
import json
import sys
import uuid
from pathlib import Path
from types import ModuleType

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "finance-supabase.py"
OWNER_ID = "11111111-1111-1111-1111-111111111111"
PROJECT_URL = "https://abndifkxpfppmllgxfnu.supabase.co"
SECRET = "finance-import-test-secret"
ENTRY_FIELDS = {
    "key",
    "sourceBytes",
    "sourceSha256",
    "destinationRevision",
    "destinationSha256",
    "matches",
}


def load_script() -> ModuleType:
    """Import the real command rather than a copied test-only implementation."""
    name = f"finance_supabase_script_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def write_source(
    tmp_path: Path, *, finance: object | None = None, cameras: object | None = None
) -> Path:
    source = tmp_path / "source"
    source.mkdir(parents=True)
    (source / "finance.json").write_text(
        json.dumps({"z": "ñ", "a": [2, 1]} if finance is None else finance), encoding="utf-8"
    )
    (source / "finance-camera-views.json").write_text(
        json.dumps({"views": {"diagram": {"x": 1}}} if cameras is None else cameras),
        encoding="utf-8",
    )
    return source


def args(source: Path, action: str, report: Path | None = None) -> list[str]:
    result = [f"--{action}", "--owner-id", OWNER_ID, "--source", str(source)]
    if report is not None:
        result.extend(["--report", str(report)])
    return result


def configured_environment() -> dict[str, str]:
    return {"SUPABASE_URL": PROJECT_URL, "SUPABASE_SECRET_KEY": SECRET}


def decoded_output(capsys: pytest.CaptureFixture[str]) -> list[dict[str, object]]:
    return json.loads(capsys.readouterr().out)


def test_missing_document_refuses_the_import(tmp_path, capsys):
    """Catches importing a partial backup as though it were authoritative."""
    script = load_script()
    source = write_source(tmp_path)
    (source / "finance-camera-views.json").unlink()

    assert script.main(args(source, "dry-run"), environ={}) == 1

    assert decoded_output(capsys) == []


@pytest.mark.parametrize("value", ["[]", "not JSON"])
def test_non_object_or_invalid_json_refuses_the_import(tmp_path, capsys, value):
    """Catches arrays and malformed data reaching the JSONB document table."""
    script = load_script()
    source = write_source(tmp_path)
    (source / "finance.json").write_text(value, encoding="utf-8")

    assert script.main(args(source, "dry-run"), environ={}) == 1

    assert decoded_output(capsys) == []


def test_canonical_digest_ignores_source_whitespace_and_key_order(tmp_path, capsys):
    """Catches a formatting-only source edit looking like a remote conflict."""
    script = load_script()
    first = write_source(tmp_path / "first", finance={"b": [2, 1], "a": "ñ"})
    second = write_source(tmp_path / "second", finance={"a": "ñ", "b": [2, 1]})
    (first / "finance.json").write_text('{\n  "b": [2, 1], "a": "ñ"\n}', encoding="utf-8")
    (second / "finance.json").write_text('{"a":"ñ","b":[2,1]}', encoding="utf-8")

    assert script.main(args(first, "dry-run"), environ={}) == 0
    first_entry = decoded_output(capsys)[0]
    assert script.main(args(second, "dry-run"), environ={}) == 0
    second_entry = decoded_output(capsys)[0]

    expected = b'{"a":"\xc3\xb1","b":[2,1]}'
    assert script.canonical_json({"b": [2, 1], "a": "ñ"}) == expected
    assert first_entry["sourceSha256"] == hashlib.sha256(expected).hexdigest()
    assert first_entry["sourceSha256"] == second_entry["sourceSha256"]
    assert first_entry["sourceBytes"] != second_entry["sourceBytes"]


def test_dry_run_requires_no_credentials_and_makes_no_requests(tmp_path, capsys):
    """Catches a local inspection needing a cloud secret or opening the network."""
    script = load_script()
    source = write_source(tmp_path)
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    assert (
        script.main(args(source, "dry-run"), environ={}, transport=httpx.MockTransport(handler))
        == 0
    )

    entries = decoded_output(capsys)
    assert calls == 0
    assert [entry["key"] for entry in entries] == ["finance", "finance-camera-views"]
    assert all(entry["destinationRevision"] is None for entry in entries)
    assert all(entry["destinationSha256"] is None for entry in entries)
    assert all(entry["matches"] is None for entry in entries)


def test_apply_inserts_absent_documents_with_bearer_and_apikey_headers(tmp_path, capsys):
    """Catches the initial controlled cutover not creating revision-one rows."""
    script = load_script()
    source = write_source(tmp_path)
    writes: list[dict[str, object]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method == "GET":
            assert request.url.path == "/rest/v1/finance_documents"
            assert request.url.params["owner_id"] == f"eq.{OWNER_ID}"
            assert request.url.params["document_key"].startswith("eq.")
            return httpx.Response(200, json=[])
        assert request.method == "POST"
        assert request.url.path == "/rest/v1/finance_documents"
        assert request.headers["apikey"] == SECRET
        assert request.headers["authorization"] == f"Bearer {SECRET}"
        row = json.loads(request.content)
        writes.append(row)
        return httpx.Response(201, json=[row])

    assert (
        script.main(
            args(source, "apply"),
            environ=configured_environment(),
            transport=httpx.MockTransport(handler),
        )
        == 0
    )

    entries = decoded_output(capsys)
    assert [(row["document_key"], row["revision"]) for row in writes] == [
        ("finance", 1),
        ("finance-camera-views", 1),
    ]
    assert all(entry["destinationRevision"] == 1 for entry in entries)
    assert all(entry["matches"] is True for entry in entries)


def test_repeated_apply_only_selects_an_identical_existing_document(tmp_path, capsys):
    """Catches a retry changing a document that was already imported."""
    script = load_script()
    source = write_source(tmp_path)
    existing = {
        "finance": {"z": "ñ", "a": [2, 1]},
        "finance-camera-views": {"views": {"diagram": {"x": 1}}},
    }
    writes = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal writes
        if request.method == "POST":
            writes += 1
            return httpx.Response(500)
        key = request.url.params["document_key"].removeprefix("eq.")
        return httpx.Response(200, json=[{"payload": existing[key], "revision": 7}])

    assert (
        script.main(
            args(source, "apply"),
            environ=configured_environment(),
            transport=httpx.MockTransport(handler),
        )
        == 0
    )

    entries = decoded_output(capsys)
    assert writes == 0
    assert [entry["destinationRevision"] for entry in entries] == [7, 7]
    assert all(entry["matches"] is True for entry in entries)


def test_apply_refuses_any_mismatch_before_mutating_an_absent_sibling(tmp_path, capsys):
    """Catches a later conflict leaving a partially imported pair behind."""
    script = load_script()
    source = write_source(tmp_path)
    writes = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal writes
        if request.method == "POST":
            writes += 1
            return httpx.Response(500)
        key = request.url.params["document_key"].removeprefix("eq.")
        if key == "finance":
            return httpx.Response(200, json=[])
        return httpx.Response(200, json=[{"payload": {"edited": True}, "revision": 4}])

    assert (
        script.main(
            args(source, "apply"),
            environ=configured_environment(),
            transport=httpx.MockTransport(handler),
        )
        == 1
    )

    entries = decoded_output(capsys)
    assert writes == 0
    assert entries[0]["destinationRevision"] is None
    assert entries[0]["matches"] is False
    assert entries[1]["destinationRevision"] == 4
    assert entries[1]["matches"] is False


@pytest.mark.parametrize(
    ("remote", "expected", "exit_code"),
    [
        (
            {
                "finance": {"z": "ñ", "a": [2, 1]},
                "finance-camera-views": {"views": {"diagram": {"x": 1}}},
            },
            [True, True],
            0,
        ),
        (
            {
                "finance": {"changed": True},
                "finance-camera-views": {"views": {"diagram": {"x": 1}}},
            },
            [False, True],
            1,
        ),
        (
            {"finance": None, "finance-camera-views": {"views": {"diagram": {"x": 1}}}},
            [False, True],
            1,
        ),
    ],
    ids=["match", "mismatch", "missing"],
)
def test_verify_distinguishes_matching_mismatched_and_missing_rows(
    tmp_path, capsys, remote, expected, exit_code
):
    """Catches verification treating absent and changed documents as equal."""
    script = load_script()
    source = write_source(tmp_path)

    def handler(request: httpx.Request) -> httpx.Response:
        key = request.url.params["document_key"].removeprefix("eq.")
        payload = remote[key]
        return httpx.Response(
            200, json=[] if payload is None else [{"payload": payload, "revision": 9}]
        )

    assert (
        script.main(
            args(source, "verify"),
            environ=configured_environment(),
            transport=httpx.MockTransport(handler),
        )
        == exit_code
    )

    entries = decoded_output(capsys)
    assert [entry["matches"] for entry in entries] == expected
    assert entries[0]["destinationRevision"] == (None if remote["finance"] is None else 9)


@pytest.mark.parametrize("owner", ["not-a-uuid", "11111111-1111-1111-1111-111111111111x"])
def test_invalid_owner_never_reaches_http(tmp_path, capsys, owner):
    """Catches a malformed identity changing the scope of the import query."""
    script = load_script()
    source = write_source(tmp_path)
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    with pytest.raises(SystemExit):
        script.main(
            ["--apply", "--owner-id", owner, "--source", str(source)],
            environ=configured_environment(),
            transport=httpx.MockTransport(handler),
        )

    assert calls == 0
    capsys.readouterr()


@pytest.mark.parametrize(
    "url",
    [
        "http://abndifkxpfppmllgxfnu.supabase.co",
        "https://wrong-project.supabase.co",
        f"{PROJECT_URL}/rest/v1",
    ],
)
def test_apply_rejects_non_allowlisted_hosts_without_requesting_them(tmp_path, capsys, url):
    """Catches administrative credentials being sent to a different endpoint."""
    script = load_script()
    source = write_source(tmp_path)
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    assert (
        script.main(
            args(source, "apply"),
            environ={"SUPABASE_URL": url, "SUPABASE_SECRET_KEY": SECRET},
            transport=httpx.MockTransport(handler),
        )
        == 1
    )

    assert calls == 0
    assert SECRET not in capsys.readouterr().out


def test_redirect_and_remote_errors_redact_secrets_from_the_report_and_stdout(tmp_path, capsys):
    """Catches an upstream diagnostic echoing the administrative credential."""
    script = load_script()
    source = write_source(tmp_path)
    report = tmp_path / "report.json"

    def handler(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": f"https://evil.example/?key={SECRET}"})

    assert (
        script.main(
            args(source, "verify", report),
            environ=configured_environment(),
            transport=httpx.MockTransport(handler),
        )
        == 1
    )

    rendered = capsys.readouterr().out + report.read_text(encoding="utf-8")
    assert SECRET not in rendered
    assert "evil.example" not in rendered


def test_report_is_atomically_replaced_and_contains_only_sanitized_entries(tmp_path, capsys):
    """Catches a report truncation or an accidental payload diagnostic."""
    script = load_script()
    source = write_source(tmp_path)
    report = tmp_path / "nested" / "finance-report.json"
    report.parent.mkdir()
    report.write_text('{"stale":"payload"}', encoding="utf-8")

    assert script.main(args(source, "dry-run", report), environ={}) == 0

    stdout_entries = decoded_output(capsys)
    report_entries = json.loads(report.read_text(encoding="utf-8"))
    assert report_entries == stdout_entries
    assert len(report_entries) == 2
    assert all(set(entry) == ENTRY_FIELDS for entry in report_entries)
    assert "payload" not in report.read_text(encoding="utf-8")
    assert list(report.parent.glob("*.tmp")) == []
