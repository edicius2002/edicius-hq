"""Exact, immutable departure partitions preserve projection inputs after pruning."""

import json
from dataclasses import FrozenInstanceError
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal
from hashlib import sha256

import pytest

from app.services.airfare_retention import retention_cutoff, summarize_departure, weighted_median

DEPARTURE = date(2026, 11, 10)


def snapshot(at, prices, **extra):
    return {
        "origin": "AQP",
        "destination": "LIM",
        "flightDate": DEPARTURE.isoformat(),
        "capturedAt": at,
        "offers": [{"price": value} for value in prices],
        **extra,
    }


def test_cutoff_uses_utc_departure_day_and_preserves_old_captures_of_future_flights():
    now = datetime(2026, 11, 12, tzinfo=UTC)
    assert retention_cutoff(now) == date(2026, 11, 11)
    assert retention_cutoff(now.astimezone(timezone(timedelta(hours=-12)))) == date(2026, 11, 11)
    assert date(2026, 11, 10) < retention_cutoff(now)
    assert not date(2026, 11, 11) < retention_cutoff(now)
    old_capture = snapshot("2026-01-01T00:00:00Z", [10], flightDate="2026-12-01")
    assert not date.fromisoformat(old_capture["flightDate"]) < retention_cutoff(now)
    with pytest.raises(ValueError):
        retention_cutoff(datetime(2026, 11, 12))


@pytest.mark.parametrize(
    ("frequencies", "expected"),
    [
        ({}, None),
        ({Decimal("10"): 2, Decimal("30"): 2}, Decimal("20")),
        ({Decimal("0"): 2, Decimal("9"): 3}, Decimal("9")),
        (
            {
                Decimal("1.00000000000000000000000000001"): 1,
                Decimal("1.00000000000000000000000000003"): 1,
            },
            Decimal("1.00000000000000000000000000002"),
        ),
        ({Decimal("1"): 10**15, Decimal("3"): 10**15}, Decimal("2")),
    ],
)
def test_weighted_median_is_exact_without_expanding_counts(frequencies, expected):
    assert weighted_median(frequencies) == expected


@pytest.mark.parametrize("count", [0, -1, True, 1.5])
def test_weighted_median_rejects_invalid_counts(count):
    with pytest.raises(ValueError):
        weighted_median({Decimal("10"): count})


@pytest.mark.parametrize("price", [Decimal("NaN"), Decimal("Infinity"), True])
def test_nonfinite_or_boolean_prices_are_rejected(price):
    with pytest.raises(ValueError):
        weighted_median({price: 1})
    with pytest.raises(ValueError):
        summarize_departure(
            "AQP", "LIM", DEPARTURE, [snapshot("2026-10-01T00:00:00Z", [price])], [], []
        )


def test_summary_preserves_zero_unsold_latest_baseline_and_logical_record_counts():
    first = snapshot("2026-10-01T23:00:00-05:00", ["10.00", "30"])
    rows = [
        first,
        dict(first),
        snapshot("2026-10-01T23:30:00-05:00", [0, None]),
        snapshot("2026-10-02T01:00:00Z", []),
        snapshot("2026-10-02T02:00:00Z", [None]),
    ]
    baseline = [
        {"flightDate": "2026-11-10", "date": "2026-09-01", "price": "40"},
        {"flightDate": "2026-11-10", "date": "2026-09-01", "price": "30.00"},
        {"flightDate": "2026-11-10", "date": "2026-09-02", "price": "0.00"},
    ]
    check = {
        "flightDate": "2026-11-10",
        "at": "2026-10-03T00:00:00Z",
        "outcome": "error",
        "error": "private raw response",
    }
    checks = [check, dict(check), {**check, "at": "2026-10-02T00:00:00Z", "outcome": "changed"}]
    summary = summarize_departure("AQP", "LIM", DEPARTURE, rows, baseline, checks)
    payload = summary.to_payload()
    assert payload == {
        "version": 1,
        "origin": "AQP",
        "destination": "LIM",
        "flight_date": "2026-11-10",
        "price_days": {"2026-10-01": [["0", 1], ["10", 1]]},
        "provider_days": {"2026-09-01": [["30", 1]], "2026-09-02": [["0", 1]]},
        "unsold_days": {"2026-10-02": 2},
        "minimum_price": "0",
        "latest_capture": "2026-10-02T02:00:00Z",
        "health": {
            "last_checked_at": "2026-10-03T00:00:00Z",
            "checks": 2,
            "changes": 1,
            "errors": 1,
        },
    }
    assert summary.key == ("AQP", "LIM", "2026-11-10")
    assert (
        summary.digest
        == sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()
        ).hexdigest()
    )
    assert "private" not in summary.canonical_json()
    with pytest.raises(FrozenInstanceError):
        summary.origin = "JFK"
    with pytest.raises(TypeError):
        summary.unsold_days["2026-10-02"] = 10
    payload["price_days"]["2026-10-01"][0][1] = 99
    assert summary.to_payload()["price_days"]["2026-10-01"][0][1] == 1


def test_hash_is_stable_under_logical_record_order_and_decimal_spelling():
    rows = [
        snapshot("2026-10-01T00:00:00Z", ["10.00"]),
        snapshot("2026-10-02T00:00:00Z", [Decimal("20.000")]),
    ]
    a = summarize_departure("AQP", "LIM", DEPARTURE, rows, [], [])
    b = summarize_departure("AQP", "LIM", DEPARTURE, list(reversed(rows)), [], [])
    assert a.digest == b.digest
    rows[0]["offers"][0]["price"] = Decimal("10")
    assert a.digest == summarize_departure("AQP", "LIM", DEPARTURE, rows, [], []).digest


def test_empty_summary_has_no_minimum_or_latest_observation():
    summary = summarize_departure("AQP", "LIM", DEPARTURE, [], [], [])
    assert summary.minimum_price is None
    assert summary.latest_capture is None
    assert summary.to_payload()["health"] == {
        "last_checked_at": None,
        "checks": 0,
        "changes": 0,
        "errors": 0,
    }


@pytest.mark.parametrize(
    "extra",
    [
        {"flightDate": "2026-11-11"},
        {"flightDate": "2026-02-30"},
        {"origin": "JFK"},
        {"capturedAt": "not-a-date"},
    ],
)
def test_summary_rejects_invalid_or_mixed_partition_rows(extra):
    with pytest.raises(ValueError):
        summarize_departure(
            "AQP", "LIM", DEPARTURE, [snapshot("2026-10-01T00:00:00Z", [10], **extra)], [], []
        )
