import json
from datetime import UTC, date, datetime
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

FIXTURES = Path(__file__).parent / "fixtures" / "fx"
NOW = datetime(2026, 9, 29, 18, tzinfo=UTC)


@pytest.mark.parametrize(
    "source",
    [
        "kambista",
        "tu-cambista",
        "securex",
        "cambio-seguro",
        "dollarhouse",
        "rextie",
        "tkambio",
        "bcrp",
        "sbs",
    ],
)
def test_standard_source(source):
    from app.services.fx.providers import fetch

    def response(request):
        assert request.extensions["timeout"]["read"] <= 30
        if source == "rextie":
            assert request.url.params["commit"] == "false"
            assert json.loads(request.content)["source_amount"] == 1000
        return httpx.Response(200, content=(FIXTURES / (source + ".txt")).read_bytes())

    with httpx.Client(transport=httpx.MockTransport(response)) as client:
        rows = fetch(source, client, NOW, date(2026, 9, 1), date(2026, 9, 29))
    assert len(rows) == 1
    assert rows[0].buy == Decimal("3.43")
    assert rows[0].sell == Decimal("3.46")
    assert "secret" not in json.dumps(rows[0].wire())
    if source in {"bcrp", "sbs"}:
        assert rows[0].effective_at == datetime(2026, 9, 25, 5, tzinfo=UTC)


@pytest.mark.parametrize(
    "buy,sell", [("0", "3.5"), ("NaN", "3.5"), ("4", "3"), ("-1", "3"), ("garbage", "3")]
)
def test_invalid_rates(buy, sell):
    from app.services.fx.providers import ProviderError, fetch

    with (
        httpx.Client(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(200, json={"buying_rate": buy, "selling_rate": sell})
            )
        ) as client,
        pytest.raises(ProviderError),
    ):
        fetch("tkambio", client, NOW)


@pytest.mark.parametrize(
    "status,body",
    [(403, "challenge"), (429, "wait"), (200, "<script>/_Incapsula_Resource</script>")],
)
def test_challenge_and_throttle(status, body):
    from app.services.fx.providers import ProviderError, fetch

    with (
        httpx.Client(
            transport=httpx.MockTransport(
                lambda r: httpx.Response(status, text=body, headers={"Retry-After": "1800"})
            )
        ) as client,
        pytest.raises(ProviderError) as error,
    ):
        fetch("bcrp", client, NOW)
    assert error.value.delay >= (21600 if status == 403 else 1800 if status == 429 else 900)


def test_timeout_and_size_are_bounded():
    from app.services.fx.providers import ProviderError, fetch

    for handler in [
        lambda r: httpx.Response(200, content=b"x" * 2100000),
        lambda r: (_ for _ in ()).throw(httpx.ReadTimeout("timeout")),
    ]:
        with (
            httpx.Client(transport=httpx.MockTransport(handler)) as client,
            pytest.raises(ProviderError),
        ):
            fetch("kambista", client, NOW)


def test_rextie_promotion_rejected():
    from app.services.fx.providers import ProviderError, fetch

    payload = json.loads((FIXTURES / "rextie.txt").read_text())
    payload["is_preferential"] = True
    with (
        httpx.Client(
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload))
        ) as client,
        pytest.raises(ProviderError),
    ):
        fetch("rextie", client, NOW)


@pytest.mark.parametrize(
    "name,start,end",
    [
        ("02.Ene.97", date(1997, 1, 1), date(1997, 1, 10)),
        ("31.Dic.20", date(2020, 1, 1), date(2020, 12, 31)),
    ],
)
def test_reference_spanish_dates_and_precision(name, start, end):
    from app.services.fx.providers import fetch

    payload = json.loads((FIXTURES / "bcrp.txt").read_text())
    payload["periods"] = [
        {"name": name, "values": ["3.41642857142857", "3.41992857142857", "3.416", "3.425"]}
    ]
    with httpx.Client(
        transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload))
    ) as client:
        row = fetch("bcrp", client, NOW, start, end)[0]
    assert row.buy == Decimal("3.41642857142857")
    assert row.effective_at.year == start.year


@pytest.mark.parametrize(
    "mutate",
    [
        lambda p: p["config"]["series"].reverse(),
        lambda p: p["periods"].append(p["periods"][0]),
        lambda p: p["periods"][0].update(name="25.Set.25"),
        lambda p: p["periods"][0].update(values=["3.4"]),
    ],
)
def test_reference_contract_mismatch_rejected(mutate):
    from app.services.fx.providers import ProviderError, fetch

    payload = json.loads((FIXTURES / "bcrp.txt").read_text())
    mutate(payload)
    with (
        httpx.Client(
            transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload))
        ) as client,
        pytest.raises(ProviderError),
    ):
        fetch("bcrp", client, NOW, date(2026, 9, 1), date(2026, 9, 29))


def test_retry_after_date():
    from app.services.fx.providers import retry_delay

    assert retry_delay("Tue, 29 Sep 2026 19:00:00 GMT", NOW) == 3600
    assert retry_delay("999999999", NOW) == 86400
