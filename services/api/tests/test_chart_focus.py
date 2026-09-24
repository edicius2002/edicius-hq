from app.adapters.models import BarFocus
from app.services.chart_focus import ChartFocusBook


def focus_payload(
    client_id: str = "tab-a",
    *,
    symbol: str = "AAPL",
    timeframe: str = "15m",
    extended: bool = True,
    active: bool = True,
) -> dict[str, object]:
    return {
        "clientId": client_id,
        "symbol": symbol,
        "timeframe": timeframe,
        "extended": extended,
        "active": active,
    }


def test_focus_uses_worker_receipt_time_not_a_client_timestamp():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)

    assert book.accept(
        {
            **focus_payload(),
            "symbol": " aapl ",
            "expiresAt": 9_999_999_999,
        },
        now=100,
    )
    assert book.active(now=144) == frozenset({BarFocus("AAPL", "15m", True)})
    assert book.active(now=145) == frozenset()


def test_release_removes_only_the_matching_client():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)
    assert book.accept(focus_payload("tab-a"), now=100)
    assert book.accept(focus_payload("tab-b", symbol="MSFT"), now=100)

    assert book.accept({"clientId": "tab-a", "active": False}, now=101)
    assert not book.accept({"clientId": "tab-a", "active": False}, now=101)
    assert book.active(now=101) == frozenset({BarFocus("MSFT", "15m", True)})


def test_heartbeat_replaces_focus_and_receipt_time():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)
    assert book.accept(focus_payload(symbol="AAPL"), now=100)
    assert book.accept(focus_payload(symbol="MSFT"), now=120)

    assert book.active(now=164) == frozenset({BarFocus("MSFT", "15m", True)})
    assert book.active(now=165) == frozenset()


def test_duplicate_focus_tuples_from_two_tabs_are_deduplicated():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)
    assert book.accept(focus_payload("tab-a"), now=100)
    assert book.accept(focus_payload("tab-b"), now=101)

    assert book.active(now=101) == frozenset({BarFocus("AAPL", "15m", True)})


def test_malformed_symbols_are_rejected():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)

    for symbol in (None, "", "   ", 42):
        payload = focus_payload()
        payload["symbol"] = symbol
        assert not book.accept(payload, now=100)
    assert book.active(now=100) == frozenset()


def test_unsupported_timeframes_are_rejected():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)

    payload = focus_payload(timeframe="2h")

    assert not book.accept(payload, now=100)
    assert book.active(now=100) == frozenset()


def test_non_boolean_focus_flags_are_rejected():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)

    for field in ("active", "extended"):
        payload = focus_payload()
        payload[field] = 1
        assert not book.accept(payload, now=100)
    payload = focus_payload()
    payload.pop("active")
    assert not book.accept(payload, now=100)


def test_identifiers_longer_than_64_characters_are_rejected():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)

    assert not book.accept(focus_payload("x" * 65), now=100)
    assert book.active(now=100) == frozenset()


def test_eighth_client_eviction_removes_the_oldest_receipt():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)
    for index in range(8):
        assert book.accept(
            focus_payload(f"tab-{index}", symbol=f"SYM{index}"),
            now=float(index),
        )

    assert book.accept(focus_payload("tab-8", symbol="SYM8"), now=8)

    active = book.active(now=8)
    assert BarFocus("SYM0", "15m", True) not in active
    assert len(active) == 8
    assert BarFocus("SYM8", "15m", True) in active


def test_expired_clients_are_cleaned_before_capacity_eviction():
    book = ChartFocusBook(ttl_seconds=5, max_clients=2)
    assert book.accept(focus_payload("tab-a", symbol="AAPL"), now=0)
    assert book.accept(focus_payload("tab-b", symbol="MSFT"), now=1)

    assert book.accept(focus_payload("tab-c", symbol="GOOG"), now=10)
    assert not book.accept({"clientId": "tab-b", "active": False}, now=10)
    assert book.active(now=10) == frozenset({BarFocus("GOOG", "15m", True)})


def test_next_expiry_returns_the_earliest_deadline_and_cleans_up():
    book = ChartFocusBook(ttl_seconds=5, max_clients=8)

    assert book.next_expiry(now=100) is None
    assert book.accept(focus_payload("tab-a"), now=100)
    assert book.accept(focus_payload("tab-b"), now=101)
    assert book.next_expiry(now=102) == 105
    assert book.next_expiry(now=105) == 106
    assert book.next_expiry(now=106) is None
