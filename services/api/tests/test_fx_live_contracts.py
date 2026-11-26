"""Reduced contracts verified against public quote endpoints on 2026-11-23."""

import gzip
import json
from datetime import UTC, datetime
from decimal import Decimal

import httpx
import pytest

from app.services.fx.providers import ProviderError, fetch

NOW = datetime(2026, 11, 23, 18, tzinfo=UTC)
KAMBISTA = {"rate": 3.437, "exchange": 343.7, "tc": {"bid": 3.437, "ask": 3.463}}
SECUREX = {"estado": True, "result": {"compra": 3.439, "venta": 3.4625}}


@pytest.mark.parametrize("source", ["kambista", "securex"])
def test_current_quote_endpoint_avoids_html_defaults_and_coupons(source):
    requests = []

    def respond(request):
        requests.append(request)
        assert "cookie" not in request.headers
        if source == "kambista":
            assert request.method == "GET"
            assert request.url.host == "api.kambista.com"
            assert request.url.path == "/v1/exchange/calculates"
            assert dict(request.url.params) == {
                "originCurrency": "USD",
                "destinationCurrency": "PEN",
                "active": "S",
                "amount": "100",
            }
            return httpx.Response(200, json={**KAMBISTA, "secret": "discard"})
        assert request.method == "POST"
        assert request.headers["accept"] == "application/json"
        assert str(request.url) == "https://securex.pe/getTipoCambio"
        assert json.loads(request.content) == {"compra": 0, "venta": 0}
        return httpx.Response(200, json={**SECUREX, "secret": "discard"})

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        row = fetch(source, client, NOW)[0]
    assert len(requests) == 1
    assert (row.buy, row.sell) == (
        (Decimal("3.437"), Decimal("3.463"))
        if source == "kambista"
        else (Decimal("3.439"), Decimal("3.4625"))
    )
    assert "secret" not in json.dumps(row.wire())
    if source == "kambista":
        assert row.context["amount_usd"] == 100
        assert row.context["method"] == "non-committing-simulation"


@pytest.mark.parametrize(
    "source,payload",
    [
        ("kambista", None),
        ("kambista", {"tc": None}),
        ("kambista", {**KAMBISTA, "exchange": 999}),
        ("kambista", {**KAMBISTA, "rate": 3.5}),
        ("kambista", {**KAMBISTA, "tc": {"bid": "NaN", "ask": 3.46}}),
        ("kambista", {**KAMBISTA, "tc": {"bid": 3.5, "ask": 3.4}}),
        ("securex", {"estado": False, "result": SECUREX["result"]}),
        ("securex", {"estado": "true", "result": SECUREX["result"]}),
        ("securex", {"estado": True, "result": None}),
        ("securex", {"estado": True, "result": {"compra": 0, "venta": 3.46}}),
        ("securex", {"estado": True, "result": {"compra": 3.5, "venta": 3.4}}),
    ],
)
def test_current_quote_contract_rejects_invalid_responses(source, payload):
    with (
        httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, json=payload))
        ) as client,
        pytest.raises(ProviderError),
    ):
        fetch(source, client, NOW)


@pytest.mark.parametrize("source", ["kambista", "securex"])
def test_api_failure_never_falls_back_to_stale_html_rates(source):
    body = '<span id="kmc-bid">3.429</span><span id="kmc-ask">3.455</span>'
    with (
        httpx.Client(
            transport=httpx.MockTransport(lambda _: httpx.Response(200, text=body))
        ) as client,
        pytest.raises(ProviderError) as error,
    ):
        fetch(source, client, NOW)
    assert error.value.code == "invalid-json"


def test_cambio_seguro_uses_gzip_instead_of_broken_brotli_stream():
    body = (
        '<button><span>Quiero soles</span><span class="tw:font-semibold">3.4370</span></button>'
        '<button><span>Quiero dólares</span><span class="tw:font-semibold">3.4650</span></button>'
    )

    def respond(request):
        assert request.headers["accept-encoding"] == "gzip, deflate"
        return httpx.Response(
            200, headers={"Content-Encoding": "gzip"}, content=gzip.compress(body.encode())
        )

    with httpx.Client(transport=httpx.MockTransport(respond)) as client:
        row = fetch("cambio-seguro", client, NOW)[0]
    assert (row.buy, row.sell) == (Decimal("3.4370"), Decimal("3.4650"))
