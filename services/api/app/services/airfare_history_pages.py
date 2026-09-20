"""Lossless history protocol, independent of HTTP and domain conversion."""

import re
from collections.abc import Awaitable, Callable, Mapping
from datetime import date
from math import isfinite
from typing import Any, NoReturn

from app.services.airfare_supabase import (
    AirfareHistoryRevisionChanged,
    AirfareRemoteRejected,
    AirfareRemoteUnavailable,
)

HistoryRpc = Callable[[str, Mapping[str, object]], Awaitable[Any]]
_ID = re.compile(r"[0-9a-f]{64}\Z")
_KEY = re.compile(r"[0-9a-f]{32}\Z")
_DECIMAL = re.compile(r"(?:0|[1-9][0-9]{0,18})\Z")
_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
_MAX_BIGINT = 9223372036854775807
_SUMMARY_FIELDS = ("origin", "destination", "health", "airports", "pairReference")


def _reject() -> NoReturn:
    raise AirfareRemoteRejected("Supabase returned an invalid history protocol response")


def _object(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        _reject()
    return value


def _decimal(value: Any, *, positive: bool = False) -> int:
    if not isinstance(value, str) or not _DECIMAL.fullmatch(value):
        _reject()
    number = int(value)
    if number > _MAX_BIGINT or (positive and number == 0):
        _reject()
    return number


def _number(value: Any, *, integral: bool = False) -> None:
    if type(value) not in (int, float):
        _reject()
    if integral and (type(value) is not int or not 0 <= value <= _MAX_BIGINT):
        _reject()
    try:
        finite = isfinite(value)
    except OverflowError:
        raise AirfareRemoteRejected("Supabase returned an invalid history number") from None
    if not finite:
        _reject()


def _header(value: Any) -> dict[str, Any]:
    obj = _object(value)
    if type(obj.get("protocolVersion")) is not int or obj["protocolVersion"] != 1:
        _reject()
    _decimal(obj.get("revision"), positive=True)
    if not isinstance(obj.get("queryKey"), str) or not _KEY.fullmatch(obj["queryKey"]):
        _reject()
    return obj


def parse_meta(value: Any, params: Mapping[str, object]) -> dict[str, Any]:
    meta = _header(value)
    if (
        meta.get("origin") != params["p_origin"]
        or meta.get("destination") != params["p_destination"]
    ):
        _reject()
    counts = _object(meta.get("counts"))
    if set(counts) != {"snapshots", "baseline"}:
        _reject()
    for count in counts.values():
        _decimal(count)
    health = _object(meta.get("health"))
    if "lastCheckedAt" not in health or (
        health["lastCheckedAt"] is not None and not isinstance(health["lastCheckedAt"], str)
    ):
        _reject()
    for key in ("checks", "changes", "errors"):
        _number(health.get(key), integral=True)
    airports = meta.get("airports")
    if not isinstance(airports, list):
        _reject()
    codes = []
    for airport_value in airports:
        airport = _object(airport_value)
        if airport.get("code") not in (params["p_origin"], params["p_destination"]):
            _reject()
        codes.append(airport["code"])
        for key in ("name", "city", "country"):
            if airport.get(key) is not None and not isinstance(airport[key], str):
                _reject()
        for key in ("latitude", "longitude"):
            _number(airport.get(key))
    expected_codes = list(
        dict.fromkeys(
            code for code in (params["p_origin"], params["p_destination"]) if code in codes
        )
    )
    if codes != expected_codes:
        _reject()
    if "pairReference" not in meta:
        _reject()
    if meta["pairReference"] is not None:
        reference = _object(meta["pairReference"])
        _number(reference.get("value"))
        _number(reference.get("dates"), integral=True)
        if reference["dates"] == 0:
            _reject()
    return meta


def _position(value: Any, dataset: str) -> tuple[str, int | str, str]:
    if not isinstance(value, list) or len(value) != 3 or any(not isinstance(v, str) for v in value):
        _reject()
    if not _ID.fullmatch(value[2]):
        _reject()
    if dataset == "snapshots":
        return value[0], _decimal(value[1], positive=True), value[2]
    for part in value[:2]:
        if not _DATE.fullmatch(part):
            _reject()
        try:
            date.fromisoformat(part)
        except ValueError:
            raise AirfareRemoteRejected("Supabase returned an invalid history date") from None
    return value[0], value[1], value[2]


def parse_page(
    value: Any, meta: dict[str, Any], dataset: str, previous: dict[str, Any] | None
) -> dict[str, Any]:
    page = _header(value)
    if (
        any(page.get(k) != meta[k] for k in ("queryKey", "revision"))
        or page.get("dataset") != dataset
    ):
        _reject()
    items = page.get("items")
    if not isinstance(items, list) or len(items) > 100 or "nextCursor" not in page:
        _reject()
    last = _position(previous["after"], dataset) if previous is not None else None
    for item_value in items:
        item = _object(item_value)
        position = _position(item.get("order"), dataset)
        if item.get("recordId") != position[2] or (last is not None and position <= last):
            _reject()
        _object(item.get("payload"))
        last = position
    cursor = page["nextCursor"]
    if cursor is not None:
        _header(cursor)
        if not items or cursor != {
            "protocolVersion": 1,
            "queryKey": meta["queryKey"],
            "revision": meta["revision"],
            "dataset": dataset,
            "after": items[-1]["order"],
        }:
            _reject()
    return page


async def read_attempt(
    rpc: HistoryRpc, params: Mapping[str, object], *, check_cancelled: Callable[[], None]
) -> dict[str, Any]:
    check_cancelled()
    meta = parse_meta(await rpc("read_airfare_history_meta", dict(params)), params)
    result = {key: meta[key] for key in _SUMMARY_FIELDS}
    for dataset in ("snapshots", "baseline"):
        expected = _decimal(meta["counts"][dataset])
        items: list[dict[str, Any]] = []
        identities: set[str] = set()
        cursor = None
        while expected:
            check_cancelled()
            page = parse_page(
                await rpc(
                    "read_airfare_history_page",
                    {
                        **params,
                        "p_revision": meta["revision"],
                        "p_dataset": dataset,
                        "p_cursor": cursor,
                        "p_page_size": 100,
                    },
                ),
                meta,
                dataset,
                cursor,
            )
            for item in page["items"]:
                if item["recordId"] in identities:
                    _reject()
                identities.add(item["recordId"])
                items.append(item["payload"])
            cursor = page["nextCursor"]
            if len(items) > expected or (cursor is not None and len(items) >= expected):
                _reject()
            if cursor is None:
                break
        if len(items) != expected:
            _reject()
        result[dataset] = items
    check_cancelled()
    final = parse_meta(
        await rpc("read_airfare_history_meta", {**params, "p_expected_revision": meta["revision"]}),
        params,
    )
    if final != meta:
        _reject()
    check_cancelled()
    return result


async def assemble_history(
    rpc: HistoryRpc,
    params: Mapping[str, object],
    *,
    check_cancelled: Callable[[], None],
    sleep: Callable[[float], Awaitable[None]],
) -> dict[str, Any]:
    for attempt in range(3):
        check_cancelled()
        try:
            return await read_attempt(rpc, params, check_cancelled=check_cancelled)
        except AirfareHistoryRevisionChanged:
            check_cancelled()
            if attempt == 2:
                raise AirfareRemoteUnavailable("Airfare history changed repeatedly") from None
            await sleep((0.1, 0.25)[attempt])
    raise AssertionError("unreachable")
