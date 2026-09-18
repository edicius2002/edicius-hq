"""The app-document importer is idempotent and never imports unknown KV files."""

import importlib.util
import json
import sys
import uuid
from pathlib import Path
from types import ModuleType

import httpx

REPO_ROOT = Path(__file__).resolve().parents[3]
SCRIPT_PATH = REPO_ROOT / "scripts" / "app-documents-supabase.py"
OWNER_ID = "11111111-1111-1111-1111-111111111111"
PROJECT_URL = "https://abndifkxpfppmllgxfnu.supabase.co"
SECRET = "app-documents-import-test-secret"


def load_script() -> ModuleType:
    name = f"app_documents_supabase_script_{uuid.uuid4().hex}"
    spec = importlib.util.spec_from_file_location(name, SCRIPT_PATH)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


def test_dry_run_is_default_and_prints_only_a_manifest(tmp_path, capsys):
    script = load_script()
    source = tmp_path / "kv"
    source.mkdir()
    (source / "watchlist.json").write_text('{"private":"payload"}', encoding="utf-8")

    assert script.main(["--owner-id", OWNER_ID, "--source", str(source)], environ={}) == 0

    manifest = json.loads(capsys.readouterr().out)
    assert manifest == [{"key": "watchlist", "sourceBytes": 21}]


def test_unknown_file_refuses_before_a_prior_known_file_can_be_inserted(tmp_path, capsys):
    script = load_script()
    source = tmp_path / "kv"
    source.mkdir()
    (source / "alert-rules.json").write_text('{"private":"known"}', encoding="utf-8")
    (source / "unknown.json").write_text('{"private":"unknown"}', encoding="utf-8")
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    assert (
        script.main(
            ["--owner-id", OWNER_ID, "--source", str(source), "--apply"],
            environ={"SUPABASE_URL": PROJECT_URL, "SUPABASE_SECRET_KEY": SECRET},
            transport=httpx.MockTransport(handler),
        )
        == 1
    )

    rendered = capsys.readouterr()
    assert calls == 0
    assert "unknown.json" in rendered.err
    assert "private" not in rendered.err + rendered.out
    assert SECRET not in rendered.err + rendered.out


def test_repeated_apply_inserts_only_absent_documents(tmp_path, capsys):
    script = load_script()
    source = tmp_path / "kv"
    source.mkdir()
    (source / "watchlist.json").write_text('{"symbols":["ABC"]}', encoding="utf-8")
    writes = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal writes
        if request.method == "GET":
            return httpx.Response(200, json=[{"payload": {"symbols": ["ABC"]}, "revision": 3}])
        writes += 1
        return httpx.Response(500)

    assert (
        script.main(
            ["--owner-id", OWNER_ID, "--source", str(source), "--apply"],
            environ={"SUPABASE_URL": PROJECT_URL, "SUPABASE_SECRET_KEY": SECRET},
            transport=httpx.MockTransport(handler),
        )
        == 0
    )
    assert writes == 0
    assert json.loads(capsys.readouterr().out) == [{"key": "watchlist", "sourceBytes": 19}]


def test_apply_accepts_an_empty_created_response_and_is_idempotent(tmp_path, capsys):
    script = load_script()
    source = tmp_path / "kv"
    source.mkdir()
    (source / "watchlist.json").write_text('{"symbols":["ABC"]}', encoding="utf-8")
    remote: dict[str, object] | None = None

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal remote
        if request.method == "GET":
            return httpx.Response(200, json=[] if remote is None else [{"document_key": "watchlist"}])
        remote = json.loads(request.content)
        return httpx.Response(201)

    arguments = ["--owner-id", OWNER_ID, "--source", str(source), "--apply"]
    environment = {"SUPABASE_URL": PROJECT_URL, "SUPABASE_SECRET_KEY": SECRET}
    assert script.main(arguments, environ=environment, transport=httpx.MockTransport(handler)) == 0
    assert remote is not None
    assert script.main(arguments, environ=environment, transport=httpx.MockTransport(handler)) == 0
    assert json.loads(capsys.readouterr().out.splitlines()[-1]) == [{"key": "watchlist", "sourceBytes": 19}]


def test_non_json_file_refuses_before_creating_a_client(tmp_path, capsys):
    script = load_script()
    source = tmp_path / "kv"
    source.mkdir()
    (source / "watchlist.json").write_text('{"symbols":[]}', encoding="utf-8")
    (source / "notes.txt").write_text("private payload", encoding="utf-8")
    calls = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return httpx.Response(500)

    assert script.main(
        ["--owner-id", OWNER_ID, "--source", str(source), "--apply"],
        environ={"SUPABASE_URL": PROJECT_URL, "SUPABASE_SECRET_KEY": SECRET},
        transport=httpx.MockTransport(handler),
    ) == 1
    rendered = capsys.readouterr()
    assert calls == 0
    assert "notes.txt" in rendered.err
    assert "private payload" not in rendered.err + rendered.out
