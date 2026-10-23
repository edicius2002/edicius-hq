"""Exercise the vendored prod6 transport without contacting SEACE."""

import asyncio
import importlib.util
import json
import logging
from datetime import UTC, datetime, timedelta
from email.utils import format_datetime
from pathlib import Path
from types import SimpleNamespace

import httpx
import pytest

DETAIL_PAYLOAD = {"uitContratoCompletoProjection": {"idContrato": 111}}


@pytest.fixture
def server(monkeypatch):
    monkeypatch.setenv("SEACE_UPDATE_CHECK", "0")
    monkeypatch.delenv("SEACE_PROD6_MAX_CONCURRENCY", raising=False)
    path = Path(__file__).resolve().parents[2] / "seace/vendor/seace_mcp/server.py"
    spec = importlib.util.spec_from_file_location("seace_transport_test", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def mock_clients(monkeypatch, server, handler):
    original = httpx.AsyncClient
    monkeypatch.setattr(
        server.httpx,
        "AsyncClient",
        lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs),
    )


@pytest.mark.parametrize("limit", [None, 2])
def test_shared_limit_covers_batches_search_and_later_calls(server, monkeypatch, limit):
    if limit is not None:
        monkeypatch.setattr(server, "PROD6_MAX_CONCURRENCY", limit)
    active = peak = 0

    async def handler(request):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.005)
        active -= 1
        payload = [] if "/archivo/" in request.url.path else DETAIL_PAYLOAD
        return httpx.Response(200, json=payload)

    mock_clients(monkeypatch, server, handler)

    async def run():
        for _ in range(2):
            results = await asyncio.gather(
                server.detalles_convocatorias_menores([str(i) for i in range(10)]),
                server.detalles_convocatorias_menores([str(i) for i in range(10, 20)]),
                server.buscar_convocatorias_menores("2026"),
            )
            assert all(result["ok"] for result in results)
            assert not results[0]["faltas"]
            assert not results[1]["faltas"]

    asyncio.run(run())
    assert peak == (limit or 5)


@pytest.mark.parametrize("phase", ["detail", "files"])
def test_forbidden_is_not_retried_and_preserves_id_and_phase(server, monkeypatch, caplog, phase):
    calls = []
    secret = "credential-secret-private-body"
    identifier = "87654321987654"

    async def handler(request):
        calls.append(request)
        failing = (phase == "detail") or "/archivo/" in request.url.path
        return (
            httpx.Response(403, text=secret)
            if failing
            else httpx.Response(200, json=DETAIL_PAYLOAD)
        )

    mock_clients(monkeypatch, server, handler)
    with caplog.at_level(logging.INFO):
        result = asyncio.run(server.detalles_convocatorias_menores([identifier]))
    missing = result["faltas"][0]
    assert missing["id"] == identifier
    assert missing["fase"] == phase
    assert missing["status"] == 403
    assert missing["tipo"] == "forbidden"
    assert missing["intentos"] == 1
    assert len(calls) == (1 if phase == "detail" else 2)
    assert secret not in json.dumps(result)
    assert identifier not in caplog.text
    assert secret not in caplog.text
    events = [json.loads(r.message) for r in caplog.records if r.name == "seace.prod6"]
    event = events[-1]
    assert event["phase"] == phase
    assert event["status"] == 403
    assert event["attempt"] == 1
    assert event["in_flight"] == 1
    assert event["latency_ms"] >= 0
    if phase == "files":
        assert event["endpoint"].endswith("/{id}/1")


@pytest.mark.parametrize(
    "failure,kind,status",
    [
        (429, "rate_limited", 429),
        (503, "server_error", 503),
        (501, "server_error", 501),
        ("timeout", "timeout", None),
        ("network", "network_error", None),
        ("invalid", "invalid_json", 200),
    ],
)
def test_errors_are_bounded_classified_and_sanitized(
    server, monkeypatch, caplog, failure, kind, status
):
    calls, delays = [], []
    secret = "SECRET-query-cookie-authorization-body"

    async def handler(request):
        calls.append(request)
        if failure == "timeout":
            raise httpx.ReadTimeout(secret + str(request.url), request=request)
        if failure == "network":
            raise httpx.ConnectError(secret + str(request.url), request=request)
        if failure == "invalid":
            return httpx.Response(200, text=secret)
        return httpx.Response(failure, text=secret, headers={"Retry-After": "2"})

    async def sleep(delay):
        delays.append(delay)

    monkeypatch.setattr(server.asyncio, "sleep", sleep)

    async def run():
        async with httpx.AsyncClient(
            transport=httpx.MockTransport(handler),
            headers={
                "Authorization": secret,
                "Cookie": secret,
            },
        ) as client:
            with pytest.raises(RuntimeError) as caught:
                await server.api6_json(
                    client,
                    "buscadorpublico",
                    "/contrataciones/listar-completo",
                    {"id_contrato": "12345678987654", "secret": secret},
                )
            return caught.value

    with caplog.at_level(logging.INFO):
        error = asyncio.run(run())
    expected_attempts = 1 if failure == "invalid" else 3
    assert len(calls) == expected_attempts
    assert error.kind == kind
    assert error.status == status
    assert error.attempts == expected_attempts
    assert secret not in str(error) + caplog.text
    assert "12345678987654" not in caplog.text
    expected_delays = [2.0, 2.0] if isinstance(failure, int) else [0.5, 1.0]
    assert delays == ([] if failure == "invalid" else expected_delays)
    events = [json.loads(r.message) for r in caplog.records if r.name == "seace.prod6"]
    assert [event["attempt"] for event in events] == list(range(1, expected_attempts + 1))
    assert all(event["outcome"] == kind for event in events)


def test_cancelled_request_releases_shared_capacity(server, monkeypatch):
    monkeypatch.setattr(server, "PROD6_MAX_CONCURRENCY", 1)

    async def run():
        entered = asyncio.Event()

        async def handler(request):
            if request.url.params.get("cancel"):
                entered.set()
                await asyncio.Event().wait()
            return httpx.Response(200, json={})

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            task = asyncio.create_task(
                server.api6_json(
                    client, "buscadorpublico", "/contrataciones/buscador", {"cancel": "1"}
                )
            )
            await entered.wait()
            task.cancel()
            with pytest.raises(asyncio.CancelledError):
                await task
            assert (
                await asyncio.wait_for(
                    server.api6_json(client, "buscadorpublico", "/contrataciones/buscador"),
                    timeout=1,
                )
                == {}
            )

    asyncio.run(run())


def test_file_failure_keeps_completed_detail_and_other_ids(server, monkeypatch):
    async def handler(request):
        if "/archivo/" in request.url.path:
            if "/111/" in request.url.path:
                return httpx.Response(403, text="private backend message")
            return httpx.Response(200, json=[])
        return httpx.Response(
            200,
            json={
                "uitContratoCompletoProjection": {"nombre": "Public notice"},
                "uitContratoItemProjectionList": [{"descripcionItem": "Item"}],
            },
        )

    mock_clients(monkeypatch, server, handler)
    result = asyncio.run(server.detalles_convocatorias_menores(["111", "222"]))
    partial = result["detalles"]["111"]
    assert partial["items"] == [{"descripcionItem": "Item"}]
    assert partial["cabecera"] == {"nombre": "Public notice"}
    assert partial["fases_completadas"] == ["detail"]
    assert "documentos" not in partial
    assert result["detalles"]["222"]["fases_completadas"] == ["detail", "files"]
    assert result["detalles"]["222"]["documentos"] == []
    assert [(f["id"], f["fase"]) for f in result["faltas"]] == [("111", "files")]


@pytest.mark.parametrize("phase", ["detail", "files"])
def test_can_request_only_pending_phase(server, monkeypatch, phase):
    paths = []

    async def handler(request):
        paths.append(request.url.path)
        return httpx.Response(200, json=[] if phase == "files" else DETAIL_PAYLOAD)

    mock_clients(monkeypatch, server, handler)
    result = asyncio.run(server.detalles_convocatorias_menores(["111"], fase=phase))
    assert not result["faltas"]
    assert len(paths) == 1
    assert ("/archivo/" in paths[0]) == (phase == "files")
    detail = result["detalles"]["111"]
    assert detail["fases_completadas"] == [phase]
    assert ("items" in detail) == (phase == "detail")
    assert ("documentos" in detail) == (phase == "files")


@pytest.mark.parametrize(
    "phase,payload",
    [
        ("detail", []),
        ("detail", {}),
        ("detail", {"message": "No result"}),
        ("detail", {"uitContratoCompletoProjection": None}),
        ("detail", {"uitContratoCompletoProjection": {}}),
        ("detail", {"uitContratoItemProjectionList": [{"descripcionItem": "Item"}]}),
        ("files", {}),
        ("files", [None]),
        ("detail", {"uitContratoItemProjectionList": {"invalid": "shape"}}),
        ("detail", {"uitContratoCompletoProjection": "invalid"}),
        ("detail", {**DETAIL_PAYLOAD, "uitContratoItemProjectionList": [None]}),
        ("detail", {**DETAIL_PAYLOAD, "uitContratoEtapaProjectionList": ["invalid"]}),
    ],
)
def test_invalid_payload_cannot_mark_phase_complete(server, monkeypatch, phase, payload):
    paths = []

    async def handler(request):
        paths.append(request.url.path)
        return httpx.Response(200, json=payload)

    mock_clients(monkeypatch, server, handler)
    result = asyncio.run(
        server.detalles_convocatorias_menores(["111"], fase="all" if phase == "detail" else phase)
    )
    assert result["detalles"] == {}
    assert result["faltas"][0]["fase"] == phase
    assert result["faltas"][0]["tipo"] == "invalid_payload"
    assert result["faltas"][0]["status"] == 200
    assert result["faltas"][0]["intentos"] == 1
    assert len(paths) == 1


@pytest.mark.parametrize(
    "lists",
    [
        {},
        {"uitContratoItemProjectionList": []},
        {
            "uitContratoItemProjectionList": None,
            "uitContratoEtapaProjectionList": [],
        },
    ],
)
def test_detail_header_with_empty_or_absent_lists_is_complete(server, monkeypatch, lists):
    async def handler(request):
        return httpx.Response(200, json={**DETAIL_PAYLOAD, **lists})

    mock_clients(monkeypatch, server, handler)
    result = asyncio.run(server.detalles_convocatorias_menores(["111"], fase="detail"))
    assert result["faltas"] == []
    assert result["detalles"]["111"] == {
        "id": "111",
        "fases_completadas": ["detail"],
        "cabecera": DETAIL_PAYLOAD["uitContratoCompletoProjection"],
        "items": [],
        "etapas": [],
    }


@pytest.mark.parametrize("status", [429, 503])
@pytest.mark.parametrize("phase", ["detail", "files"])
@pytest.mark.parametrize("header_kind", ["seconds", "http_date"])
@pytest.mark.parametrize("seconds", [3, 3600])
def test_long_retry_after_returns_pending_phase_without_sleep_or_early_retry(
    server, monkeypatch, status, phase, header_kind, seconds
):
    now = datetime(2026, 10, 23, 12, tzinfo=UTC)
    monkeypatch.setattr(server, "datetime", SimpleNamespace(now=lambda tz: now))
    header = (
        str(seconds)
        if header_kind == "seconds"
        else format_datetime(now + timedelta(seconds=seconds), usegmt=True)
    )
    paths, delays = [], []

    async def handler(request):
        paths.append(request.url.path)
        if phase == "files" and "/archivo/" not in request.url.path:
            return httpx.Response(200, json=DETAIL_PAYLOAD)
        return httpx.Response(status, headers={"Retry-After": header})

    async def sleep(delay):
        delays.append(delay)

    monkeypatch.setattr(server.asyncio, "sleep", sleep)
    mock_clients(monkeypatch, server, handler)
    result = asyncio.run(server.detalles_convocatorias_menores(["111"]))
    assert delays == []
    assert len(paths) == (1 if phase == "detail" else 2)
    assert len(result["faltas"]) == 1
    assert result["faltas"][0] == {
        "id": "111",
        "fase": phase,
        "status": status,
        "intentos": 1,
        "tipo": "rate_limited" if status == 429 else "server_error",
        "retry_after_seconds": seconds,
        "error": f"API de convocatorias menores: {phase} "
        f"{'rate_limited' if status == 429 else 'server_error'} (HTTP {status}, intentos 1)",
    }
    if phase == "detail":
        assert result["detalles"] == {}
    else:
        assert result["detalles"]["111"]["fases_completadas"] == ["detail"]
        assert "documentos" not in result["detalles"]["111"]


def test_retry_after_http_date_and_invalid_header(server, monkeypatch, caplog):
    delays = []
    headers = iter(
        [
            format_datetime(datetime.now(UTC) + timedelta(seconds=2)),
            "SECRET-malformed-header",
        ]
    )

    async def handler(request):
        try:
            header = next(headers)
        except StopIteration:
            return httpx.Response(200, json={})
        return httpx.Response(429, headers={"Retry-After": header})

    async def sleep(delay):
        delays.append(delay)

    monkeypatch.setattr(server.asyncio, "sleep", sleep)

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            return await server.api6_json(client, "buscadorpublico", "/contrataciones/buscador")

    with caplog.at_level(logging.INFO):
        assert asyncio.run(run()) == {}
    assert 0.5 <= delays[0] <= 2
    assert delays[1] == 1.0
    assert "SECRET" not in caplog.text


@pytest.mark.parametrize("value", ["0", "-1", "invalid"])
def test_invalid_limit_fails_at_startup(server, monkeypatch, value):
    monkeypatch.setenv("SEACE_PROD6_MAX_CONCURRENCY", value)
    with pytest.raises(ValueError):
        server.__spec__.loader.exec_module(server)


def test_limit_is_loaded_from_environment(server, monkeypatch):
    monkeypatch.setenv("SEACE_PROD6_MAX_CONCURRENCY", "1")
    server.__spec__.loader.exec_module(server)
    active = peak = 0

    async def handler(request):
        nonlocal active, peak
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.005)
        active -= 1
        return httpx.Response(200, json={})

    async def run():
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            await asyncio.gather(
                *(
                    server.api6_json(client, "buscadorpublico", "/contrataciones/buscador")
                    for _ in range(4)
                )
            )

    asyncio.run(run())
    assert peak == 1


def test_success_logs_allowlisted_fields_and_same_opaque_id_across_phases(
    server, monkeypatch, caplog
):
    identifier, secret = "87654321987654", "SECRET-success-body"

    async def handler(request):
        return httpx.Response(
            200,
            json=[]
            if "/archivo/" in request.url.path
            else {
                "uitContratoCompletoProjection": {"publicText": secret},
            },
            headers={"Set-Cookie": secret, "Authorization": secret},
        )

    mock_clients(monkeypatch, server, handler)
    with caplog.at_level(logging.INFO):
        result = asyncio.run(server.detalles_convocatorias_menores([identifier]))
    assert not result["faltas"]
    events = [json.loads(r.message) for r in caplog.records if r.name == "seace.prod6"]
    assert len(events) == 2
    assert events[0]["id_ref"] == events[1]["id_ref"]
    assert len(events[0]["id_ref"]) == 16
    assert all(event["outcome"] == "success" and event["status"] == 200 for event in events)
    assert secret not in caplog.text
    assert identifier not in caplog.text


def test_retry_backoff_releases_global_capacity(server, monkeypatch):
    monkeypatch.setattr(server, "PROD6_MAX_CONCURRENCY", 1)

    async def run():
        backoff, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def sleep(delay):
            backoff.set()
            await release.wait()

        async def handler(request):
            nonlocal calls
            calls += 1
            return httpx.Response(503) if calls == 1 else httpx.Response(200, json={})

        monkeypatch.setattr(server.asyncio, "sleep", sleep)
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            retrying = asyncio.create_task(
                server.api6_json(client, "buscadorpublico", "/contrataciones/buscador")
            )
            await backoff.wait()
            assert (
                await asyncio.wait_for(
                    server.api6_json(client, "buscadorpublico", "/contrataciones/buscador"),
                    timeout=1,
                )
                == {}
            )
            release.set()
            assert await retrying == {}

    asyncio.run(run())
