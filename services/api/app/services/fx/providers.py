"""Fixed public endpoints. No cookies, challenge handling or upstream payload storage."""

from __future__ import annotations

import json
import re
from collections.abc import Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from email.utils import parsedate_to_datetime
from html.parser import HTMLParser
from math import isfinite
from typing import Any

import httpx

from .models import REFERENCES, SOURCES, Observation

URLS = dict(
    zip(
        SOURCES[:7],
        (
            "https://kambista.com/",
            "https://tucambista.pe/",
            "https://securex.pe/",
            "https://cambioseguro.com/",
            "https://app.dollarhouse.pe/",
            "https://app.rextie.com/api/v1/fxrates/rate/?origin=home&commit=false",
            "https://tkambio.com/wp-admin/admin-ajax.php",
        ),
        strict=True,
    )
)
BCRP = "https://estadisticas.bcrp.gob.pe/estadisticas/series/api/PD04637PD-PD04638PD-PD04639PD-PD04640PD/json/"
MONTHS = dict(
    zip(
        ("ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "set", "oct", "nov", "dic"),
        range(1, 13),
        strict=True,
    )
)


class ProviderError(ValueError):
    def __init__(self, code: str = "invalid-response", delay: int = 900):
        super().__init__(code)
        self.delay = delay


class Node:
    def __init__(
        self,
        tag: str = "",
        attrs: Sequence[tuple[str, str | None]] = (),
        parent: Node | None = None,
    ):
        self.tag, self.attrs, self.parent = tag, dict(attrs), parent
        self.children: list[Node] = []
        self.parts: list[str | Node] = []

    @property
    def text(self) -> str:
        return " ".join(p if isinstance(p, str) else p.text for p in self.parts).strip()

    def has(self, cls: str) -> bool:
        return cls in (self.attrs.get("class") or "").split()

    def walk(self) -> list[Node]:
        return [self] + [n for c in self.children for n in c.walk()]


class Document(HTMLParser):
    def __init__(self, text: str):
        super().__init__()
        self.root = self.current = Node()
        self.feed(text)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag, attrs, self.current)
        self.current.children.append(node)
        self.current.parts.append(node)
        if tag not in {
            "br",
            "hr",
            "img",
            "input",
            "meta",
            "link",
            "source",
            "area",
            "embed",
            "wbr",
            "base",
            "col",
            "param",
            "track",
        }:
            self.current = node

    def handle_endtag(self, tag: str) -> None:
        node = self.current
        while node.parent:
            if node.tag == tag:
                self.current = node.parent
                return
            node = node.parent

    def handle_data(self, data: str) -> None:
        self.current.parts.append(data)


def html_rates(source: str, text: str) -> tuple[str, str]:
    nodes = Document(text).root.walk()
    values: dict[str, str] = {}
    ids = {
        "kambista": ("valcompra", "valventa"),
        "dollarhouse": ("buy-exchange-rate", "sell-exchange-rate"),
    }
    if source in ids:
        return tuple(next(n.text for n in nodes if n.attrs.get("id") == id_) for id_ in ids[source])  # type: ignore[return-value]
    for n in nodes:
        for side, label in [("buy", "compra"), ("sell", "venta")]:
            if (
                source == "tu-cambista"
                and n.has("tc-quote-rate")
                and n.parent
                and n.parent.has("tc-quote-rates")
            ):
                match = re.search(rf"{label}:\s*([0-9.]+)", n.text, re.I)
                if match:
                    values[side] = match[1]
            elif (
                source == "securex"
                and n.has("fs-16-bold")
                and n.text.lower() == label + ":"
                and n.parent
            ):
                siblings = n.parent.children
                following = siblings[siblings.index(n) + 1]
                if following.tag == "span":
                    values[side] = following.text
            elif (
                source == "cambio-seguro"
                and n.has("rates-price")
                and "dólar " + label in n.text.lower()
            ):
                values[side] = next(c.text for c in n.walk() if c.has("value-rate"))
    return values["buy"], values["sell"]


def retry_delay(value: str, now: datetime) -> int:
    try:
        seconds = float(value)
    except ValueError:
        try:
            seconds = (parsedate_to_datetime(value) - now).total_seconds()
        except (ValueError, TypeError, OverflowError):
            seconds = 900
    if not isfinite(seconds):
        return 900
    return int(max(60, min(86400, seconds)))


def fetch(
    source: str,
    client: httpx.Client,
    now: datetime,
    start: date | None = None,
    end: date | None = None,
    *,
    response_cache: dict[str, Any] | None = None,
) -> list[Observation]:
    if source not in SOURCES:
        raise ProviderError("invalid-source")
    start, end = start or (now.date() - timedelta(days=14)), end or now.date()
    url = BCRP + f"{start}/{end}" if source in REFERENCES else URLS[source]
    kwargs: dict[str, Any] = {}
    method = "GET"
    if source == "rextie":
        method = "POST"
        kwargs = dict(
            json={"source_currency": "USD", "target_currency": "PEN", "source_amount": 1000},
            headers={
                "rextie-country": "pe",
                "rextie-language": "es",
                "rextie-app-platform": "rextie-web",
                "rextie-app-version": "6.6.27",
            },
        )
    elif source == "tkambio":
        method, kwargs = "POST", {"data": {"action": "get_exchange_rate"}}
    try:
        if source in REFERENCES and response_cache is not None and url in response_cache:
            cached = response_cache[url]
            if isinstance(cached, ProviderError):
                raise cached
            return reference_rows(source, cached, now, start, end)
        client.cookies.clear()
        with client.stream(method, url, timeout=30, follow_redirects=False, **kwargs) as response:
            if response.status_code == 403:
                raise ProviderError("forbidden", 21600)
            if response.status_code == 429:
                raise ProviderError(
                    "rate-limited", retry_delay(response.headers.get("Retry-After", "900"), now)
                )
            if not 200 <= response.status_code < 300:
                raise ProviderError("http-error")
            body = bytearray()
            for chunk in response.iter_bytes():
                body.extend(chunk)
                if len(body) > 2_000_000:
                    raise ProviderError("response-too-large")
        text = body.decode("utf-8")
        if source in REFERENCES:
            payload = json.loads(text)
            if response_cache is not None:
                response_cache[url] = payload
            return reference_rows(source, payload, now, start, end)
        context: dict[str, Any] = {"variant": "standard", "method": "public-quote"}
        if source in {"rextie", "tkambio"}:
            obj = json.loads(text, parse_float=Decimal)
            if not isinstance(obj, dict):
                raise ProviderError("invalid-response")
            if source == "rextie":
                if (
                    any(
                        obj.get(k)
                        for k in ("quote_pk", "promo_code", "campaign", "is_preferential")
                    )
                    or obj["source_currency"] != "USD"
                    or obj["target_currency"] != "PEN"
                    or Decimal(obj["source_amount"]) != 1000
                ):
                    raise ProviderError("unexpected-quote")
                buy, sell = obj["fx_rate_buy"], obj["fx_rate_sell"]
                if Decimal(obj["target_amount"]) != Decimal(buy) * 1000:
                    raise ProviderError("unexpected-quote")
                context.update(
                    amount_usd=1000, direction="USD/PEN", method="non-committing-simulation"
                )
            else:
                buy, sell = obj["buying_rate"], obj["selling_rate"]
        else:
            buy, sell = html_rates(source, text)
        return [
            Observation(
                source, now, now, Decimal(str(buy).strip()), Decimal(str(sell).strip()), context
            )
        ]
    except ProviderError as error:
        if source in REFERENCES and response_cache is not None:
            response_cache.setdefault(url, error)
        raise
    except (
        httpx.HTTPError,
        ValueError,
        KeyError,
        TypeError,
        IndexError,
        StopIteration,
        ArithmeticError,
    ):
        failure = ProviderError()
        if source in REFERENCES and response_cache is not None:
            response_cache.setdefault(url, failure)
        raise failure from None
    finally:
        client.cookies.clear()


def reference_rows(
    source: str, obj: Any, now: datetime, start: date, end: date
) -> list[Observation]:
    if not isinstance(obj, dict) or not isinstance(obj.get("config"), dict):
        raise ProviderError("invalid-series")
    series = obj["config"].get("series")
    if not isinstance(series, list) or any(
        not isinstance(row, dict) or not isinstance(row.get("name"), str) for row in series
    ):
        raise ProviderError("invalid-series")
    periods = obj.get("periods")
    if not isinstance(periods, list):
        raise ProviderError("invalid-periods")
    expected = [
        ("interbancario", "compra"),
        ("interbancario", "venta"),
        ("sbs", "compra"),
        ("sbs", "venta"),
    ]
    if len(series) != 4 or any(
        not all(part in row["name"].lower() for part in parts)
        for row, parts in zip(series, expected, strict=True)
    ):
        raise ProviderError("invalid-series")
    rows = []
    previous = None
    for period in periods:
        if not isinstance(period, dict) or not isinstance(period.get("name"), str):
            raise ProviderError("invalid-date")
        day, month, year = period["name"].split(".")
        years = [y for y in range(start.year, end.year + 1) if y % 100 == int(year)]
        if len(years) != 1:
            raise ProviderError("invalid-date")
        effective = date(years[0], MONTHS[month.lower()], int(day))
        if not start <= effective <= end or (previous is not None and effective <= previous):
            raise ProviderError("invalid-date")
        previous = effective
        values = period.get("values")
        if (
            not isinstance(values, list)
            or len(values) != 4
            or any(not isinstance(value, str) for value in values)
        ):
            raise ProviderError("invalid-values")
        index = 0 if source == "bcrp" else 2
        buy, sell = values[index : index + 2]
        if "n.d." in (buy, sell):
            continue
        rows.append(
            Observation(
                source,
                now,
                datetime(effective.year, effective.month, effective.day, 5, tzinfo=UTC),
                Decimal(buy),
                Decimal(sell),
                {
                    "via": "BCRPData",
                    "series": (
                        "PD04637PD-PD04638PD" if source == "bcrp" else "PD04639PD-PD04640PD"
                    ),
                },
            )
        )
    return rows
