# Investing Live Candles and Volume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active Investing candle use the same live tick as the watchlist while applying provider-authoritative OHLCV updates for Yahoo extended sessions and Binance 24/7 markets across all seven chart intervals.

**Architecture:** The browser advertises its visible chart through an expiring owner-private focus Broadcast. The Pi acquires one authoritative live bar per unique focus—native Binance klines or bounded Yahoo short-range aggregation—and broadcasts immutable bar snapshots beside the existing quote ticks. The frontend treats historical bars as a replaceable base, applies the newest authoritative bar, then replays only a newer quote tick so the watchlist and candle close never diverge.

**Tech Stack:** Python 3.12, asyncio, httpx, websockets, FastAPI service modules, Supabase Realtime Broadcast/RLS, React 19, TypeScript 7, TanStack Query, Vitest/Testing Library, pytest, pgTAP.

**Spec:** `docs/superpowers/specs/2026-09-22-investing-live-candles-volume-design.md`

## Global Constraints

- The Pi remains the only provider-facing runtime; browser code may contact only Supabase.
- Supported providers are Yahoo sessions (`PRE`, `REGULAR`, `POST`) and Binance 24/7 pairs.
- Supported timeframes are exactly `1m`, `5m`, `15m`, `1h`, `1d`, `1w`, and `1M`.
- Quote Broadcast stays bounded to one batch per 500 ms; changed bar Broadcast uses the same bound.
- Yahoo live-bar polling is limited to one request cycle per unique focus every five seconds; completed daily prefixes are cached for 60 seconds.
- Focus heartbeats run every 15 seconds, expire after 45 seconds on the worker clock, and are capped at eight clients.
- Live focus and bars are Broadcast-only and never become high-frequency PostgreSQL application rows.
- Volume comes only from provider bars or klines; tick counts, last quantities, and rolling 24-hour volume are forbidden substitutes.
- Existing historical bar queries and 60-second quote snapshots remain the initial-load and recovery paths.
- The untracked `edicius-reader-2218568-2026-09-19T17-30-45.893Z.json` belongs to the user and must remain untouched.

## Review Focus

- A quote tick arriving before any historical bars must be retained for replay but must not create a misleading one-candle chart; Task 7 pins this.
- A focus payload with malformed values, an oversized identifier, or a forged timestamp must not extend worker work; Task 3 pins this.
- An unchanged price with corrected volume must still publish and redraw; Tasks 5 and 9 pin this.
- New York daylight-saving and the 09:30 hourly anchor must not place regular trades in premarket buckets; Tasks 2 and 7 pin this.
- An authoritative response completing after a newer quote tick must correct OHLCV without moving the candle close backward; Tasks 7 and 9 pin this.

---

## File Structure

### Backend contracts and providers

- `services/api/app/adapters/models.py` — add provider-neutral `BarFocus` and `LiveBar` contracts.
- `services/api/app/adapters/binance_bar_stream.py` — parse and maintain native Binance kline subscriptions for active focus tuples.
- `services/api/app/adapters/yahoo_live_bars.py` — fetch short-range Yahoo bars and aggregate the current focused candle.
- `services/api/app/adapters/live_bars.py` — split focus tuples by provider and merge Binance/Yahoo live-bar iterators.
- `services/api/app/services/chart_focus.py` — validate, expire, deduplicate, and bound per-tab focus leases.
- `services/api/app/services/market_worker.py` — own focus state, bar consumption, changed-bar coalescing, retry, and shutdown.
- `services/api/app/services/collector_cloud.py` — publish owner-private live bar batches.
- `scripts/market-worker.py` — receive browser focus Broadcasts on the worker's existing Supabase Realtime client.

### Database authorization

- `supabase/migrations/20260922000000_market_chart_focus_broadcast.sql` — grant authenticated owner-only focus Broadcast publication.
- `supabase/tests/market_chart_focus_broadcast.sql` — pin focus INSERT policy and preserve quote-topic denial.

### Frontend transport and state

- `apps/web/src/features/investing/data/liveBars.ts` — validate live bars, compute provider-aware provisional buckets, and reconcile base/bar/tick layers.
- `apps/web/src/features/investing/data/supabaseMarket.ts` — decode `bars` Broadcasts and send private focus/release events.
- `apps/web/src/features/investing/data/quoteStream.ts` — carry bar events through the existing single owner-private market channel.
- `apps/web/src/features/investing/hooks/useQuoteStream.ts` — coalesce both newest ticks and newest live bars per animation frame.
- `apps/web/src/features/investing/hooks/useChartFocus.ts` — heartbeat and release the visible chart focus.
- `apps/web/src/features/investing/chart/useCandles.ts` — merge historical bars, the selected live bar, and selected tick; react immediately to provider session transitions.
- `apps/web/src/features/investing/InvestingPage.tsx` — order hooks so one tick map feeds both quotes and candles.

### Tests

- `services/api/tests/test_binance_bar_stream.py`
- `services/api/tests/test_yahoo_live_bars.py`
- `services/api/tests/test_chart_focus.py`
- `services/api/tests/test_live_bars.py`
- `services/api/tests/test_market_worker.py`
- `services/api/tests/test_collector_cloud.py`
- `services/api/tests/test_market_worker_command.py`
- `apps/web/src/features/investing/data/liveBars.test.ts`
- `apps/web/src/features/investing/data/supabaseMarket.test.ts`
- `apps/web/src/features/investing/data/quoteStream.test.ts`
- `apps/web/src/features/investing/hooks/useQuoteStream.test.tsx`
- `apps/web/src/features/investing/hooks/useChartFocus.test.tsx`
- `apps/web/src/features/investing/chart/useCandles.test.tsx`
- `apps/web/src/app/App.test.tsx`

---

### Task 1: Provider-neutral live-bar contract and Binance kline stream

**Files:**

- Modify: `services/api/app/adapters/models.py:67-75,129-150`
- Create: `services/api/app/adapters/binance_bar_stream.py`
- Create: `services/api/tests/test_binance_bar_stream.py`

**Interfaces:**

- Consumes: existing `Bar` values and Binance combined-stream conventions from `binance_stream.py`.
- Produces: `BarFocus(symbol: str, timeframe: str, extended: bool)` and `LiveBar(symbol: str, timeframe: str, extended: bool, as_of: float, bar: Bar, provider: str)`; `parse_kline(message: str) -> LiveBar | None`; `BinanceBarStream.watch(set[BarFocus])`; `BinanceBarStream.bars() -> AsyncIterator[LiveBar]`.

- [ ] **Step 1: Restore the locked development environments**

Run from the repository root:

```powershell
npm ci
& '.\services\api\.venv\Scripts\python.exe' -m pip install -r services/api/requirements.txt
git diff -- package-lock.json services/api/requirements.txt
```

Expected: installs succeed and the final diff is empty. If either manifest changes, stop and restore it before continuing because dependency upgrades are outside this feature.

- [ ] **Step 2: Write failing contract and parser tests**

Create literal Binance frames covering all interval mappings, a volume-only change, a malformed kline, and a combined envelope:

```python
@pytest.mark.parametrize("timeframe", ["1m", "5m", "15m", "1h", "1d", "1w", "1M"])
def test_parse_kline_returns_complete_authoritative_bar(timeframe):
    event = json.dumps({
        "stream": f"btcusdt@kline_{timeframe}",
        "data": {"e": "kline", "E": 1_790_076_602_250, "s": "BTCUSDT", "k": {
            "t": 1_790_075_700_000, "i": timeframe, "o": "100", "h": "104",
            "l": "99", "c": "102", "v": "12.5", "x": False,
        }},
    })

    update = parse_kline(event)

    assert update == LiveBar(
        symbol="BTCUSDT", timeframe=timeframe, extended=False,
        as_of=1_790_076_602.25,
        bar=Bar(time=1_790_075_700, open=100, high=104, low=99, close=102, volume=12.5),
        provider="binance",
    )
```

Add an async test that calls `watch()` twice, proves the URL contains one kline stream per unique focus in sorted order, and proves a changed focus interrupts the old connection and reconnects with the full desired set.

- [ ] **Step 3: Run the tests and verify the expected red state**

Run:

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_binance_bar_stream.py -q --basetemp .tmp/pytest-binance-live-bars
```

Expected: collection fails because `BarFocus`, `LiveBar`, and `binance_bar_stream` do not exist.

- [ ] **Step 4: Add the minimal contracts and kline adapter**

Add frozen slot dataclasses in `models.py`:

```python
@dataclass(frozen=True, slots=True)
class BarFocus:
    symbol: str
    timeframe: str
    extended: bool


@dataclass(frozen=True, slots=True)
class LiveBar:
    symbol: str
    timeframe: str
    extended: bool
    as_of: float
    bar: Bar
    provider: str
```

Implement `parse_kline` with finite-number validation, millisecond-to-second conversion, exact interval allowlisting, and `extended=False`. Implement `BinanceBarStream` with the same generation/reconnect pattern as `BinanceStream`; `watch()` must ignore Yahoo focuses and rebuild only when the desired Binance set changes.

The parser's core is:

```python
INTERVALS = frozenset({"1m", "5m", "15m", "1h", "1d", "1w", "1M"})


def parse_kline(message: str) -> LiveBar | None:
    try:
        envelope = json.loads(message)
        payload = envelope.get("data", envelope)
        kline = payload["k"]
        values = tuple(float(kline[key]) for key in ("o", "h", "l", "c", "v"))
        symbol, timeframe = str(payload["s"]), str(kline["i"])
        start, as_of = int(kline["t"]) // 1000, float(payload["E"]) / 1000
    except (KeyError, TypeError, ValueError):
        return None
    if timeframe not in INTERVALS or not all(math.isfinite(value) for value in values):
        return None
    open_, high, low, close, volume = values
    return LiveBar(
        symbol=symbol.upper(), timeframe=timeframe, extended=False, as_of=as_of,
        bar=Bar(start, open_, high, low, close, volume), provider="binance",
    )
```

- [ ] **Step 5: Run focused and existing stream tests**

Run:

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_binance_bar_stream.py services/api/tests/test_stream.py -q --basetemp .tmp/pytest-binance-live-bars-green
```

Expected: all tests pass, including existing ticker behavior.

- [ ] **Step 6: Commit Task 1**

```powershell
git add services/api/app/adapters/models.py services/api/app/adapters/binance_bar_stream.py services/api/tests/test_binance_bar_stream.py
git commit -m "feat(investing): stream authoritative Binance candles"
```

---

### Task 2: Yahoo current-bar aggregation for every session and timeframe

**Files:**

- Modify: `services/api/app/adapters/yahoo.py:101-158`
- Create: `services/api/app/adapters/yahoo_live_bars.py`
- Create: `services/api/tests/test_yahoo_live_bars.py`

**Interfaces:**

- Consumes: `BarFocus`, `LiveBar`, existing Yahoo chart parsing, `ZoneInfo("America/New_York")`.
- Produces: `aggregate_live_bar(focus: BarFocus, minute_bars: Sequence[Bar], daily_bars: Sequence[Bar], as_of: float) -> LiveBar | None`; `YahooLiveBarClient.fetch(focus: BarFocus) -> LiveBar | None`, with the client owning its `httpx.AsyncClient` and 60-second daily-prefix cache.

- [ ] **Step 1: Write failing intraday aggregation tests**

Use literal provider bars at 09:29, 09:30, 09:59, and 10:29 New York time. Assert that `extended=False` excludes the 09:29 bar and that `1h` begins at 09:30 rather than 09:00:

```python
def test_regular_hour_is_anchored_at_0930_and_excludes_premarket():
    focus = BarFocus("AAPL", "1h", False)
    update = aggregate_live_bar(focus, minute_fixture(), [], AS_OF)

    assert update.bar.time == ny_timestamp("2026-09-22T09:30:00")
    assert update.bar.open == 100
    assert update.bar.high == 104
    assert update.bar.low == 99
    assert update.bar.close == 103
    assert update.bar.volume == 60
```

Parameterize `1m`, `5m`, `15m`, and `1h`; add a DST fixture on the first trading Monday after the offset change and assert the same local 09:30 anchor.

- [ ] **Step 2: Run the intraday tests red**

Run:

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_yahoo_live_bars.py -q --basetemp .tmp/pytest-yahoo-live-bars-red
```

Expected: import failure for `yahoo_live_bars`.

- [ ] **Step 3: Implement session filtering and intraday aggregation**

Add helpers with explicit signatures:

```python
def yahoo_session_at(timestamp: int) -> str:
    """Return PRE, REGULAR, POST, or CLOSED in America/New_York."""


def intraday_bucket_start(timestamp: int, timeframe: str, session: str) -> int:
    """Use 04:00, 09:30, or 16:00 New York anchors."""
```

Aggregate only bars in the focus's active bucket. For `extended=False`, accept only `REGULAR`; for `extended=True`, accept every non-closed minute. Derive OHLCV with first/max/min/last/sum and preserve the first bar's timestamp as the bucket start.

Use one aggregation primitive rather than separate OHLC implementations:

```python
def combine(time: int, bars: Sequence[Bar]) -> Bar | None:
    if not bars:
        return None
    ordered = sorted(bars, key=lambda bar: bar.time)
    return Bar(
        time=time,
        open=ordered[0].open,
        high=max(bar.high for bar in ordered),
        low=min(bar.low for bar in ordered),
        close=ordered[-1].close,
        volume=sum(bar.volume for bar in ordered),
    )
```

- [ ] **Step 4: Run intraday tests green**

Run the command from Step 2. Expected: intraday and DST tests pass.

- [ ] **Step 5: Add failing daily, weekly, monthly, and correction tests**

Pin these literal outcomes:

```python
def test_extended_daily_bar_includes_pre_regular_and_post_minutes():
    update = aggregate_live_bar(BarFocus("AAPL", "1d", True), all_session_minutes(), [], AS_OF)
    assert update.bar == Bar(time=DAY_OPEN, open=98, high=106, low=97, close=105, volume=175)


def test_week_uses_completed_days_plus_today_minutes_without_double_counting():
    update = aggregate_live_bar(BarFocus("AAPL", "1w", True), today_minutes(), completed_days(), AS_OF)
    assert update.bar.volume == 1_275


def test_provider_volume_correction_can_reduce_the_authoritative_bar():
    before = aggregate_live_bar(FOCUS, minutes(volume=100), [], AS_OF)
    after = aggregate_live_bar(FOCUS, minutes(volume=80), [], AS_OF + 5)
    assert after.bar.volume == 80 < before.bar.volume
```

For `1M`, include a prior-month daily bar and assert it is excluded. For zero volume, assert the bar remains present with `volume == 0`.

- [ ] **Step 6: Run the new tests red and implement long-interval aggregation**

Run the command from Step 2 and confirm failures show incorrect/missing long-interval output. Implement `1d`, ISO-week-in-New-York, and calendar-month selection. Exclude today's incomplete daily bar before combining completed daily bars with today's one-minute aggregate.

Select completed prefixes by local date, then call the same `combine` primitive:

```python
today = local_date(as_of)
completed = [bar for bar in daily_bars if local_date(bar.time) < today]
if focus.timeframe == "1w":
    completed = [bar for bar in completed if local_date(bar.time).isocalendar()[:2] == today.isocalendar()[:2]]
elif focus.timeframe == "1M":
    completed = [bar for bar in completed if (local_date(bar.time).year, local_date(bar.time).month) == (today.year, today.month)]
current_day = combine(day_bucket_start(as_of), selected_minutes)
pieces = [*completed, *([] if current_day is None else [current_day])]
```

- [ ] **Step 7: Add the bounded Yahoo fetch seam**

Expose a reusable Yahoo chart request/parser in `yahoo.py` rather than duplicating HTTP policy. Its `fetch_chart_bars(...) -> tuple[list[Bar], float]` result must return strict live bars plus `as_of` derived from the newest accepted Yahoo timestamp; local wall-clock time is not provider evidence. Keep the existing historical `parse_bars` behavior intact, but make the live parser reject a row whose volume is absent or non-finite while accepting an upstream numeric zero. Implement `YahooLiveBarClient.fetch` so intraday/daily views request one day of one-minute bars, while weekly/monthly views also request daily prefixes. Cache completed daily prefixes for 60 seconds on the client instance, not in the pure aggregation function. Add `httpx.MockTransport` tests proving `includePrePost=true`, the bounded ranges, cache expiry, provider-derived `as_of`, no update when the minute series is empty, numeric zero preservation, and rejection of malformed/null live volume.

The owning object keeps the cache explicit and injectable:

```python
class YahooLiveBarClient:
    def __init__(self, client: httpx.AsyncClient, *, clock=time.monotonic) -> None:
        self._client = client
        self._clock = clock
        self._daily: dict[str, tuple[float, list[Bar]]] = {}

    async def fetch(self, focus: BarFocus) -> LiveBar | None:
        minutes, as_of = await yahoo.fetch_chart_bars(
            self._client, focus.symbol, interval="1m", range_="1d", extended=True
        )
        if not minutes:
            return None
        daily: list[Bar] = []
        if focus.timeframe in {"1w", "1M"}:
            daily = await self._daily_prefix(focus.symbol)
        return aggregate_live_bar(focus, minutes, daily, as_of)
```

- [ ] **Step 8: Run Yahoo adapter suites**

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_yahoo_live_bars.py services/api/tests/test_market.py -q --basetemp .tmp/pytest-yahoo-live-bars-green
```

Expected: all tests pass and existing historical parsing is unchanged.

- [ ] **Step 9: Commit Task 2**

```powershell
git add services/api/app/adapters/yahoo.py services/api/app/adapters/yahoo_live_bars.py services/api/tests/test_yahoo_live_bars.py
git commit -m "feat(investing): aggregate live Yahoo candles"
```

---

### Task 3: Expiring and bounded chart-focus leases

**Files:**

- Create: `services/api/app/services/chart_focus.py`
- Create: `services/api/tests/test_chart_focus.py`

**Interfaces:**

- Consumes: untrusted Broadcast payload mappings and `BarFocus`.
- Produces: `ChartFocusBook.accept(payload: object, now: float) -> bool`; `ChartFocusBook.active(now: float) -> frozenset[BarFocus]`; `ChartFocusBook.next_expiry(now: float) -> float | None`.

- [ ] **Step 1: Write failing focus lifecycle tests**

```python
def test_focus_uses_worker_receipt_time_not_a_client_timestamp():
    book = ChartFocusBook(ttl_seconds=45, max_clients=8)
    assert book.accept({
        "clientId": "tab-a", "symbol": " aapl ", "timeframe": "15m",
        "extended": True, "active": True, "expiresAt": 9_999_999_999,
    }, now=100)
    assert book.active(now=144) == frozenset({BarFocus("AAPL", "15m", True)})
    assert book.active(now=145) == frozenset()
```

Add tests for release, heartbeat replacement, duplicate tuples from two tabs, malformed symbols, unsupported timeframes, non-boolean flags, identifiers longer than 64 characters, eight-client eviction of the oldest receipt, and cleanup before eviction.

- [ ] **Step 2: Run the tests red**

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_chart_focus.py -q --basetemp .tmp/pytest-chart-focus-red
```

Expected: import failure for `chart_focus`.

- [ ] **Step 3: Implement the pure lease book**

Store `clientId -> (BarFocus, received_at)` and normalize symbols with `registry.normalize_symbol`. Ignore every unknown payload key, but validate every required field exactly. `active()` must expire entries before returning a deduplicated `frozenset`; `active: false` removes only the matching client id and does not require the remaining focus fields.

Use this state transition shape:

```python
def accept(self, payload: object, now: float) -> bool:
    if not isinstance(payload, Mapping):
        return False
    client_id = payload.get("clientId")
    if not isinstance(client_id, str) or not 1 <= len(client_id) <= 64:
        return False
    if payload.get("active") is False:
        return self._leases.pop(client_id, None) is not None
    focus = decode_focus(payload)
    if focus is None:
        return False
    self._expire(now)
    if client_id not in self._leases and len(self._leases) >= self._max_clients:
        oldest = min(self._leases, key=lambda key: self._leases[key][1])
        self._leases.pop(oldest)
    self._leases[client_id] = (focus, now)
    return True
```

- [ ] **Step 4: Run the tests green and commit**

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_chart_focus.py -q --basetemp .tmp/pytest-chart-focus-green
git add services/api/app/services/chart_focus.py services/api/tests/test_chart_focus.py
git commit -m "feat(investing): track expiring chart focus leases"
```

---

### Task 4: Composite live-bar acquisition

**Files:**

- Create: `services/api/app/adapters/live_bars.py`
- Create: `services/api/tests/test_live_bars.py`

**Interfaces:**

- Consumes: `BinanceBarStream`, `YahooLiveBarClient.fetch`, `registry.provider_for`, and `set[BarFocus]`.
- Produces: `CompositeBarStream.watch(focuses: set[BarFocus]) -> None`; `CompositeBarStream.bars() -> AsyncIterator[LiveBar]`.

- [ ] **Step 1: Write failing provider split and polling tests**

Use fake Binance and Yahoo sources. Assert that `BTCUSDT` reaches only Binance, `AAPL` reaches only Yahoo, duplicate focus tuples produce one acquisition, Yahoo polls immediately then at five seconds while its session can trade, and no Yahoo poll occurs after its focus is removed. With an injected wall clock at 03:00 New York, assert there is no fetch, the task sleeps only until the next weekday 04:00 open, and polling resumes there without a new focus message.

Add a failure/backoff test with a fake clock/sleep sequence:

```python
assert waits == [5.0, 10.0, 20.0, 40.0, 60.0]
```

Then return one valid bar and assert the next wait resets to `5.0`. Add a quiet-source test proving one provider's silence does not block bars from the other.

- [ ] **Step 2: Run the tests red**

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_live_bars.py -q --basetemp .tmp/pytest-composite-bars-red
```

Expected: import failure for `live_bars`.

- [ ] **Step 3: Implement the composite stream**

Use one bounded queue to merge child iterators. `watch()` replaces the entire desired set, sends Binance its subset, and starts/cancels one Yahoo polling task per unique Yahoo focus. Cancellation must interrupt the five-second wait. Catch provider errors per Yahoo focus, never around the merged loop, so one failed symbol cannot stop another provider.

The desired-set transition stays atomic:

```python
async def watch(self, focuses: set[BarFocus]) -> None:
    yahoo = {focus for focus in focuses if registry.provider_for(focus.symbol) == "yahoo"}
    binance = focuses - yahoo
    await self._binance.watch(binance)
    for focus in self._yahoo_tasks.keys() - yahoo:
        self._yahoo_tasks.pop(focus).cancel()
    for focus in yahoo - self._yahoo_tasks.keys():
        self._yahoo_tasks[focus] = asyncio.create_task(self._poll_yahoo(focus))
```

`_poll_yahoo` first calls the pure `yahoo_session_at`/`seconds_until_yahoo_open` helpers from Task 2. While closed, it waits until the next weekday 04:00 New York boundary without treating closure as a failure or increasing backoff. While tradable, it places each non-`None` result on the shared queue, waits five seconds after success, doubles failure backoff to 60 seconds, and re-raises `CancelledError`.

- [ ] **Step 4: Run provider and composite suites**

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_live_bars.py services/api/tests/test_binance_bar_stream.py services/api/tests/test_yahoo_live_bars.py -q --basetemp .tmp/pytest-composite-bars-green
```

Expected: all pass.

- [ ] **Step 5: Commit Task 4**

```powershell
git add services/api/app/adapters/live_bars.py services/api/tests/test_live_bars.py
git commit -m "feat(investing): merge focused live bar sources"
```

---

### Task 5: Market worker bar publication and retry

**Files:**

- Modify: `services/api/app/services/collector_cloud.py:228-241`
- Modify: `services/api/app/services/market_worker.py:136-365`
- Modify: `services/api/tests/test_collector_cloud.py:23-132`
- Modify: `services/api/tests/test_market_worker.py:113-350`

**Interfaces:**

- Consumes: `ChartFocusBook`, `CompositeBarStream`, `LiveBar`.
- Produces: `CollectorCloud.broadcast_live_bars(rows) -> int`; `MarketWorker.accept_focus(payload: object) -> bool`; `MarketWorker.accept_bar(bar: LiveBar) -> None`; `MarketWorker.publish_bars() -> int`.

- [ ] **Step 1: Write failing cloud-boundary tests**

Assert one batch posts to:

```text
/realtime/v1/api/broadcast/market-quotes:<owner>/events/bars?private=true
```

Assert the body is exactly `{"bars": LIVE_BAR_ROWS}`, where `LIVE_BAR_ROWS` is the literal fixture passed to the method. Empty input makes no request, redirects are rejected, and 429/5xx/4xx response bodies never appear in raised messages.

- [ ] **Step 2: Run cloud tests red, implement, and run green**

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_collector_cloud.py -q --basetemp .tmp/pytest-live-bar-cloud-red
```

Add `broadcast_live_bars` by following the existing sanitized `broadcast_quote_ticks` boundary, changing only event name and top-level payload key. Rerun the same command and expect PASS.

```python
def broadcast_live_bars(self, bars: Sequence[Mapping[str, Any]]) -> int:
    if not bars:
        return 0
    payload = [dict(bar) for bar in bars]
    self._request(
        "POST",
        f"{self._project_url}/realtime/v1/api/broadcast/"
        f"market-quotes:{self._owner_id}/events/bars",
        body={"bars": payload},
        params={"private": "true"},
    )
    return len(payload)
```

- [ ] **Step 3: Write failing worker tests**

Add tests proving:

```python
def test_volume_only_change_is_a_visible_bar_update():
    worker.accept_bar(live_bar(close=100, volume=10, as_of=1))
    assert asyncio.run(worker.publish_bars()) == 1


def test_newer_as_of_without_an_ohlcv_change_is_not_rebroadcast():
    worker.accept_bar(live_bar(close=100, volume=10, as_of=1))
    assert asyncio.run(worker.publish_bars()) == 1
    worker.accept_bar(live_bar(close=100, volume=10, as_of=2))
    assert asyncio.run(worker.publish_bars()) == 0
    assert worker._live_bar_pending == {}
    worker.accept_bar(live_bar(close=100, volume=12, as_of=2))
    assert asyncio.run(worker.publish_bars()) == 1


def test_failed_bar_broadcast_retries_only_newest_snapshot():
    remote.broadcast_live_bars.side_effect = [CollectorCloudUnavailable("offline"), 1]
    worker.accept_bar(live_bar(close=100, volume=10, as_of=1))
    assert asyncio.run(worker.publish_bars()) == 0
    worker.accept_bar(live_bar(close=101, volume=12, as_of=2))
    assert asyncio.run(worker.publish_bars()) == 1
    assert remote.broadcast_live_bars.call_args.args[0][0]["bar"]["close"] == 101
```

Also test focus heartbeat immediately updates `bar_stream.watch`, lease expiry removes focus without another browser message, quote publication continues when bar publication fails, and shutdown cancels bar consumer/focus tasks promptly.

- [ ] **Step 4: Run worker tests red**

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_market_worker.py -q --basetemp .tmp/pytest-market-worker-bars-red
```

Expected: failures identify missing focus/bar methods and background tasks.

- [ ] **Step 5: Implement worker focus and bar tasks**

Add independent pending and last-sent maps keyed by `(symbol, timeframe, extended)`. Use `asOf` to order competing snapshots, but deduplicate publication on candle identity plus OHLCV so a newer fetch with identical market data does not create an empty visual update. Never deduplicate on price alone: a volume-only correction must publish. Run bar publish on the existing 500 ms publisher beat or a sibling task with the same constant. Add a focus-maintenance task that wakes on focus changes or the next lease expiry and calls `bar_stream.watch(book.active(clock()))`.

Start quote consumption, bar consumption, focus maintenance, and publication before reconciliation. During shutdown, cancel and gather every task, preserve existing final quote flush, and re-raise non-cancellation background failures.

Keep bar coalescing independent from quote coalescing:

```python
def accept_bar(self, update: LiveBar) -> None:
    key = (update.symbol, update.timeframe, update.extended)
    current = self._live_bar_pending.get(key)
    if current is None or update.as_of >= current.as_of:
        self._live_bar_pending[key] = update


def bar_reading(update: LiveBar) -> tuple[int, float, float, float, float, float]:
    bar = update.bar
    return (bar.time, bar.open, bar.high, bar.low, bar.close, bar.volume)


async def publish_bars(self) -> int:
    pending = dict(self._live_bar_pending)
    candidates = {
        key: update for key, update in pending.items()
        if bar_reading(update) != self._last_bar_reading.get(key)
    }
    for key, update in pending.items():
        if key not in candidates and self._live_bar_pending.get(key) is update:
            self._live_bar_pending.pop(key)
    if not candidates:
        return 0
    rows = [live_bar_wire(update) for update in candidates.values()]
    try:
        await asyncio.to_thread(self.cloud.broadcast_live_bars, rows)
    except CollectorCloudError:
        return 0
    for key, update in candidates.items():
        self._last_bar_reading[key] = bar_reading(update)
        if self._live_bar_pending.get(key) is update:
            self._live_bar_pending.pop(key)
    return len(rows)
```

- [ ] **Step 6: Run worker/cloud suites green**

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_market_worker.py services/api/tests/test_collector_cloud.py -q --basetemp .tmp/pytest-market-worker-bars-green
```

Expected: all pass with no warning logs from expected failure cases.

- [ ] **Step 7: Commit Task 5**

```powershell
git add services/api/app/services/collector_cloud.py services/api/app/services/market_worker.py services/api/tests/test_collector_cloud.py services/api/tests/test_market_worker.py
git commit -m "feat(investing): publish focused live bars"
```

---

### Task 6: Focus Broadcast authorization and Pi subscription

**Files:**

- Create: `supabase/migrations/20260922000000_market_chart_focus_broadcast.sql`
- Create: `supabase/tests/market_chart_focus_broadcast.sql`
- Modify: `scripts/market-worker.py:31-118`
- Modify: `services/api/tests/test_market_worker_command.py:115-244`

**Interfaces:**

- Consumes: `MarketWorker.accept_focus(payload)`.
- Produces: authenticated owner-only publication on `market-focus:<auth.uid()>`; worker subscription forwarding only the nested Broadcast payload.

- [ ] **Step 1: Write the failing pgTAP policy test**

Create this six-assertion test:

```sql
begin;
select plan(6);
select is(
  (select cmd from pg_policies where schemaname = 'realtime' and tablename = 'messages'
    and policyname = 'market_chart_focus_broadcast_insert_own'),
  'INSERT', 'focus policy permits publication');
select is(
  (select roles::text from pg_policies where schemaname = 'realtime' and tablename = 'messages'
    and policyname = 'market_chart_focus_broadcast_insert_own'),
  '{authenticated}', 'only authenticated clients publish focus');
select ok(
  coalesce((select with_check like '%extension%broadcast%' from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_chart_focus_broadcast_insert_own'), false),
  'only Broadcast messages');
select ok(
  coalesce((select with_check like '%market-focus:%uid%' from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_chart_focus_broadcast_insert_own'), false),
  'topic is bound to auth.uid');
select is(
  (select count(*) from pg_policies where schemaname = 'realtime'
    and tablename = 'messages' and policyname = 'market_quote_broadcast_select_own'
    and cmd = 'SELECT'),
  1::bigint, 'quote receive policy remains');
select is(
  (select count(*) from pg_policies where schemaname = 'realtime'
    and tablename = 'messages' and cmd = 'INSERT'
    and coalesce(with_check, '') like '%market-quotes:%'),
  0::bigint, 'clients cannot publish quote events');
select * from finish();
rollback;
```

Run:

```powershell
npx supabase test db supabase/tests/market_chart_focus_broadcast.sql
```

Expected: the new test fails because the focus policy does not exist. The command targets the repository's local Supabase test database, consistent with the existing database-test plans and runbook.

- [ ] **Step 2: Add the migration and rerun pgTAP**

```sql
create policy market_chart_focus_broadcast_insert_own
on realtime.messages
for insert
to authenticated
with check (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) = 'market-focus:' || (select auth.uid())::text
);
```

Expected: all migration tests pass and the existing quote policy remains read-only.

- [ ] **Step 3: Write failing command subscription tests**

Extend the fake channel so it records `on_broadcast`. Assert `subscribe_requests()` registers event `focus` on private topic `market-focus:<owner>`, unwraps `{"payload": focus}`, and calls `worker.accept_focus(focus)`. Assert malformed callback envelopes pass an inert object and cannot raise through the Realtime callback. Preserve join timeout, reconnect, and `remove_all_channels` tests.

- [ ] **Step 4: Run command tests red, implement, and run green**

```powershell
& '.\services\api\.venv\Scripts\python.exe' -m pytest services/api/tests/test_market_worker_command.py -q --basetemp .tmp/pytest-market-focus-command
```

Update `RequestSubscription` to hold both request and focus channels while health-checking the shared client. Create the focus channel with `client.channel(f"market-focus:{worker.owner_id}", {"config": {"private": True}})`, register `focus_channel.on_broadcast("focus", callback)`, and join both channels before reporting success. Rerun the command and expect PASS.

Keep the callback a non-throwing trust boundary:

```python
def on_focus(envelope: object) -> None:
    payload = envelope.get("payload") if isinstance(envelope, dict) else None
    worker.accept_focus(payload)


focus = client.channel(
    f"market-focus:{worker.owner_id}", {"config": {"private": True}}
)
focus.on_broadcast("focus", on_focus)
```

- [ ] **Step 5: Commit Task 6**

```powershell
git add supabase/migrations/20260922000000_market_chart_focus_broadcast.sql supabase/tests/market_chart_focus_broadcast.sql scripts/market-worker.py services/api/tests/test_market_worker_command.py
git commit -m "feat(investing): authorize private chart focus"
```

---

### Task 7: Pure frontend live-candle reconciliation

**Files:**

- Create: `apps/web/src/features/investing/data/liveBars.ts`
- Create: `apps/web/src/features/investing/data/liveBars.test.ts`

**Interfaces:**

- Consumes: `Bar` from `@/shared/api/market`, `Tick` from `quoteStream`, and `LiveBarContext { symbol, timeframe, extended, hasSession }`.
- Produces: `LiveBarUpdate`; `liveBarKey(value: Pick<LiveBarUpdate, 'symbol' | 'timeframe' | 'extended'>) -> string`; `mergeLiveBars(base, authoritative, tick, context) -> Bar[]`; session-aware `bucketStart` kept module-private (`hasSession=true` means New York boundaries, `false` means UTC exchange boundaries).

- [ ] **Step 1: Write failing base/authoritative/tick merge tests**

```typescript
it('replays a newer tick after replacing the authoritative OHLCV bar', () => {
  const result = mergeLiveBars(
    BASE,
    liveBar({ asOf: 200, close: 101, volume: 80 }),
    tick({
      time: 201,
      price: 103,
    }),
    CONTEXT,
  );

  expect(result.at(-1)).toEqual({
    time: LAST_TIME,
    open: 100,
    high: 103,
    low: 99,
    close: 103,
    volume: 80,
  });
});
```

Add tests for an older/equal tick not replaying, downward authoritative high/volume correction, immutable input arrays, and a tick before empty base returning `[]`.

- [ ] **Step 2: Run tests red**

```powershell
npm test -w web -- --run src/features/investing/data/liveBars.test.ts
```

Expected: module import failure.

- [ ] **Step 3: Implement authoritative replacement and safe replay**

Validate symbol/timeframe/extended identity before applying. Replace only equal bar times, append only a newer bar time, and ignore older bars. Replay a tick only when `tick.time !== null && tick.time > authoritative.asOf`; if there is no authoritative update, compare with the current last bar and provider-aware bucket.

The merge order is explicit:

```typescript
export function mergeLiveBars(
  base: Bar[],
  authoritative: LiveBarUpdate | undefined,
  tick: Tick | undefined,
  context: LiveBarContext,
): Bar[] {
  if (!base.length) return base;
  const withBar = authoritative ? applyAuthoritative(base, authoritative, context) : base;
  if (!tick || tick.symbol !== context.symbol || tick.time === null) return withBar;
  if (authoritative && tick.time <= authoritative.asOf) return withBar;
  return applyTick(withBar, tick, context);
}
```

- [ ] **Step 4: Add failing bucket/session tests**

Use hand-checked epoch literals and parameterize all seven timeframes for Yahoo/New York and Binance/UTC. Include DST, `PRE → REGULAR`, `REGULAR → POST`, week/month rollover, price rise/fall, and a provisional next candle:

```typescript
expect(mergeLiveBars(BARS_AT_PRE_CLOSE, null, regularTickAt0930, YAHOO_1H)).toEqual([
  ...BARS_AT_PRE_CLOSE,
  { time: REGULAR_0930, open: 102, high: 102, low: 102, close: 102, volume: 0 },
]);
```

Assert a postmarket tick cannot mutate the regular `15:30` hourly candle.

- [ ] **Step 5: Run red, implement bucket rules, then run green**

Implement New York anchors 04:00/09:30/16:00 with `Intl.DateTimeFormat` parts rather than hard-coded UTC offsets. Use UTC calendar boundaries for Binance. Run the command from Step 2 until every test passes.

Keep provisional tick mutation limited to OHLC:

```typescript
function updateBar(bar: Bar, price: number): Bar {
  return {
    ...bar,
    high: Math.max(bar.high, price),
    low: Math.min(bar.low, price),
    close: price,
  };
}

function provisional(time: number, price: number): Bar {
  return { time, open: price, high: price, low: price, close: price, volume: 0 };
}
```

- [ ] **Step 6: Commit Task 7**

```powershell
git add apps/web/src/features/investing/data/liveBars.ts apps/web/src/features/investing/data/liveBars.test.ts
git commit -m "feat(investing): reconcile live candles in the browser"
```

---

### Task 8: Browser bar transport, coalescing, and focus heartbeat

**Files:**

- Modify: `apps/web/src/features/investing/data/supabaseMarket.ts:149-201`
- Modify: `apps/web/src/features/investing/data/supabaseMarket.test.ts:285-390`
- Modify: `apps/web/src/features/investing/data/quoteStream.ts:19-163`
- Modify: `apps/web/src/features/investing/data/quoteStream.test.ts:143-230`
- Modify: `apps/web/src/features/investing/hooks/useQuoteStream.ts:25-150`
- Modify: `apps/web/src/features/investing/hooks/useQuoteStream.test.tsx:20-115`
- Create: `apps/web/src/features/investing/hooks/useChartFocus.ts`
- Create: `apps/web/src/features/investing/hooks/useChartFocus.test.tsx`

**Interfaces:**

- Consumes: `LiveBarUpdate`, authenticated Supabase session, existing owner-private market topic.
- Produces: `subscribeMarketUpdates(onTicks, onBars, onStatus)`; `openChartFocus() -> Promise<ChartFocusPublisher>` where `ChartFocusPublisher` exposes `publish(focus): Promise<void>` and `close(): Promise<void>`; `QuoteStreamState.bars: Map<string, LiveBarUpdate>`; `useChartFocus(input)`.

- [ ] **Step 1: Write failing live-bar decoder tests**

Extend the fake Supabase channel to capture both `ticks` and `bars` handlers. Feed one batch containing a valid row, NaN-equivalent malformed values, wrong booleans, an invalid timeframe, and a partial bar. Assert only the fully valid row reaches `onBars` and its key is `AAPL:15m:true`. Assert ticks still arrive through the same channel and status callback.

- [ ] **Step 2: Run decoder tests red**

```powershell
npm test -w web -- --run src/features/investing/data/supabaseMarket.test.ts
```

Expected: `bars` is not registered and no bar callback exists.

- [ ] **Step 3: Implement one-channel market decoding**

Rename the low-level subscription to `subscribeMarketUpdates` and register both Broadcast events before `.subscribe()`. Keep `subscribeQuoteTicks` as a small compatibility wrapper only if another call site remains after this task; otherwise remove it and update tests. Validate every finite number and exact timeframe before constructing `LiveBarUpdate`.

Register both handlers on the same channel:

```typescript
channel = supabase
  .channel(`market-quotes:${owner}`, { config: { private: true } })
  .on('broadcast', { event: 'ticks' }, ({ payload }) => {
    const ticks = ticksFromPayload(payload);
    if (!disposed && ticks.length) onTicks(ticks);
  })
  .on('broadcast', { event: 'bars' }, ({ payload }) => {
    const bars = liveBarsFromPayload(payload);
    if (!disposed && bars.length) onBars(bars);
  })
  .subscribe((status) => !disposed && onStatus?.(status));
```

- [ ] **Step 4: Write failing stream/hook coalescing tests**

Prove `openQuoteStream` filters bar symbols to the wanted set, and `useQuoteStream` retains the newest `asOf` per live-bar key. Queue two bar updates for the same key in one animation frame—same price, volumes 10 then 12—and assert the rendered map contains volume 12. Queue two different timeframe keys and assert both survive.

- [ ] **Step 5: Run red, implement coalescing, and run green**

```powershell
npm test -w web -- --run src/features/investing/data/quoteStream.test.ts src/features/investing/hooks/useQuoteStream.test.tsx
```

Add `onBars` to stream options and one bounded `Map<string, LiveBarUpdate>` queue beside ticks. Order by `asOf`; an older bar can never replace a newer one.

```typescript
for (const update of incomingBars) {
  const key = liveBarKey(update);
  const previous = queuedBars.get(key);
  if (!previous || update.asOf >= previous.asOf) queuedBars.set(key, update);
}
```

- [ ] **Step 6: Write failing focus heartbeat tests**

With fake timers, assert:

- focus sends immediately and at 15,000 ms;
- symbol/timeframe/extended changes release the old client id and immediately send the new focus;
- unmount sends `active: false` best-effort;
- session lookup failure produces no channel leak; and
- a focus send failure does not throw through React or lower quote live state.

- [ ] **Step 7: Implement focus transport and hook**

`openChartFocus` must resolve the current owner, join `market-focus:<owner>` with `{ config: { private: true } }`, wait for `SUBSCRIBED`, and return one publisher that reuses that joined channel for every heartbeat. `publish` calls `channel.send({ type: 'broadcast', event: 'focus', payload })`; `close` is idempotent and removes the channel. `useChartFocus` owns one `crypto.randomUUID()` client id per mount, sends heartbeat payloads through the publisher, publishes `active: false` before clean close, and disposes timers/channel safely before or after async session resolution.

The publisher contract is concrete:

```typescript
export type ChartFocusPublisher = {
  publish: (focus: ChartFocusMessage) => Promise<void>;
  close: () => Promise<void>;
};

const publish = async (payload: ChartFocusMessage) => {
  const result = await channel.send({ type: 'broadcast', event: 'focus', payload });
  if (result !== 'ok') throw new CollectorRequestError('focus_unavailable');
};
```

- [ ] **Step 8: Run the complete focused frontend transport tests**

```powershell
npm test -w web -- --run src/features/investing/data/supabaseMarket.test.ts src/features/investing/data/quoteStream.test.ts src/features/investing/hooks/useQuoteStream.test.tsx src/features/investing/hooks/useChartFocus.test.tsx
```

Expected: all pass.

- [ ] **Step 9: Commit Task 8**

```powershell
git add apps/web/src/features/investing/data/supabaseMarket.ts apps/web/src/features/investing/data/supabaseMarket.test.ts apps/web/src/features/investing/data/quoteStream.ts apps/web/src/features/investing/data/quoteStream.test.ts apps/web/src/features/investing/hooks/useQuoteStream.ts apps/web/src/features/investing/hooks/useQuoteStream.test.tsx apps/web/src/features/investing/hooks/useChartFocus.ts apps/web/src/features/investing/hooks/useChartFocus.test.tsx
git commit -m "feat(investing): transport live bars and chart focus"
```

---

### Task 9: Integrate live bars into `useCandles` and Investing

**Files:**

- Modify: `apps/web/src/features/investing/chart/useCandles.ts:84-132`
- Modify: `apps/web/src/features/investing/chart/useCandles.test.tsx:15-58`
- Modify: `apps/web/src/features/investing/InvestingPage.tsx:103-177,292-315`
- Modify: `apps/web/src/app/App.test.tsx:218-350`

**Interfaces:**

- Consumes: `ticks` and `bars` from `useQuoteStream`, `mergeLiveBars`, `useChartFocus`.
- Produces: `useCandles(symbol, timeframe, tick, liveBars)` returning the already-merged `Candles.bars`; Investing renders that one array into indicators and `CandleChart`.

- [ ] **Step 1: Write failing hook reconciliation tests**

Render `useCandles` with one historical bar, an authoritative update, and a newer tick. Assert returned bars contain authoritative volume and tick close. Rerender with a lower-volume newer authoritative bar and assert the volume decreases. Rerender to another symbol/timeframe and assert the old overlay disappears synchronously.

Add session tests where a `POST` tick arrives while the clock-derived regime is still regular and where `CLOSED` arrives while the clock still says extended. Assert `POST` requests the extended query key and focus immediately rather than waiting for `REGIME_TICK_MS`; assert `CLOSED` retains the historical series but releases Yahoo live focus. Add a Binance case proving `hasSession=false` keeps focus active through a New York closed period.

- [ ] **Step 2: Run hook tests red**

```powershell
npm test -w web -- --run src/features/investing/chart/useCandles.test.tsx
```

Expected: the current two-argument hook ignores all live inputs.

- [ ] **Step 3: Implement merged candles and provider-state transitions**

Change the signature to:

```typescript
export function useCandles(
  symbol: string,
  timeframe: string,
  tick: Tick | undefined,
  liveBars: Map<string, LiveBarUpdate>,
): Candles;
```

Derive an effective regime from canonical tick `marketState` when present, otherwise use `useRegime()`: `REGULAR → regular`, `PRE|POST → extended`, and `CLOSED → closed`. Compute `wantExtended`, select `liveBars.get(liveBarKey({ symbol, timeframe, extended: wantExtended }))`, and call `useChartFocus` with that exact query variant only when `!hasSession || effectiveRegime !== 'closed'`; transitioning inactive makes the hook publish `active: false`. Memoize `mergeLiveBars` with `LiveBarContext { symbol, timeframe, extended: wantExtended, hasSession }` and build `isGhost` from the merged bar count so a newly appended daily/weekly/monthly candle is correctly translucent.

- [ ] **Step 4: Write the failing page-level synchronization test**

In `App.test.tsx`, mock one historical candle and open the accessible candle table. Deliver one live tick through the existing stream harness. Assert the watchlist row and the table's Close cell both show the same new literal price before any bar refetch. Deliver a `bars` event with unchanged close and lower volume; assert the Volume cell decreases while the watchlist price remains unchanged.

- [ ] **Step 5: Run the page test red**

```powershell
npm test -w web -- --run src/app/App.test.tsx
```

Expected: the watchlist changes but the candle table retains its historical close/volume.

- [ ] **Step 6: Reorder page hooks and pass selected live inputs**

Build `wanted` and call `useQuoteStream` before `useCandles`; this is a static hook order on every render. Select:

```typescript
const selectedTick = ticks.get(symbol);
const candles = useCandles(symbol, timeframe, selectedTick, bars);
```

Keep focus-key and extended-variant selection inside `useCandles` so `InvestingPage` does not duplicate regime logic. Feed `candles.bars` to indicators and the chart exactly once.

- [ ] **Step 7: Run focused Investing tests green**

```powershell
npm test -w web -- --run src/features/investing/chart/useCandles.test.tsx src/features/investing/chart/CandleChart.test.tsx src/features/investing/data/liveBars.test.ts src/app/App.test.tsx
```

Expected: all pass, including price synchronization and downward volume correction.

- [ ] **Step 8: Commit Task 9**

```powershell
git add apps/web/src/features/investing/chart/useCandles.ts apps/web/src/features/investing/chart/useCandles.test.tsx apps/web/src/features/investing/InvestingPage.tsx apps/web/src/app/App.test.tsx
git commit -m "feat(investing): synchronize watchlist and live candles"
```

---

### Task 10: Full verification and live smoke evidence

**Files:**

- Modify only if verification reveals a defect in files already owned by Tasks 1–9.

**Interfaces:**

- Consumes: the completed feature and committed test seams.
- Produces: a clean, reproducible verification record; no new production API.

- [ ] **Step 1: Run backend quality gates**

```powershell
npm run lint:api
npm run typecheck:api
npm run api:test
```

Expected: all pass. Record every failing test by name before changing code; do not omit unrelated baseline failures.

- [ ] **Step 2: Run frontend quality gates**

```powershell
npm run typecheck
npm run lint
npm test
npm run build
npm run format:check
```

Expected: all pass with no warnings introduced by Investing.

- [ ] **Step 3: Run database and diff gates**

```powershell
npx supabase test db
git diff --check
git status --short --branch
```

Expected: migration tests pass; diff check is silent; only intentional feature files and the user's pre-existing untracked JSON appear.

- [ ] **Step 4: Run a Binance live smoke test**

Start the market worker and web app through the repository commands, select a liquid Binance pair, and observe for at least two native kline updates. Confirm with browser-visible evidence that:

- watchlist price and candle close show the same newest tick;
- the volume column changes when a kline volume-only update arrives; and
- switching `1m → 5m → 1d` yields matching native interval timestamps.

Capture only sanitized timestamps, symbols, prices, and volumes; never capture auth headers or Supabase keys.

- [ ] **Step 5: Run a Yahoo-session smoke test**

During whichever Yahoo session is currently active, select a liquid symbol and confirm two five-second authoritative updates. In premarket or after-hours, confirm the candle remains ghosted and includes extended volume; in regular hours, confirm the 09:30-aligned bucket and regular-only focus. If Yahoo is closed, replay the committed PRE/REGULAR/POST fixtures through the browser test command and state that a real closed-session observation produced no fabricated updates.

- [ ] **Step 6: Scan and remove diagnostic artifacts**

```powershell
rg -n "\[DEBUG-" apps/web/src services/api scripts supabase
git status --short
```

Expected: no debug markers or throwaway probes remain; the user's JSON remains untouched.

- [ ] **Step 7: Commit only verification-driven corrections, if any**

If Steps 1–6 required a correction, rerun the exact failing gate and then the complete affected suite. Inspect `git diff --name-only`, then stage only the feature paths from Tasks 1–9; never stage the user's JSON. Use this explicit path set, where unchanged paths are harmless:

```powershell
git add services/api/app/adapters/models.py services/api/app/adapters/binance_bar_stream.py services/api/app/adapters/yahoo.py services/api/app/adapters/yahoo_live_bars.py services/api/app/adapters/live_bars.py services/api/app/services/chart_focus.py services/api/app/services/collector_cloud.py services/api/app/services/market_worker.py services/api/tests/test_binance_bar_stream.py services/api/tests/test_yahoo_live_bars.py services/api/tests/test_chart_focus.py services/api/tests/test_live_bars.py services/api/tests/test_market_worker.py services/api/tests/test_collector_cloud.py services/api/tests/test_market_worker_command.py scripts/market-worker.py supabase/migrations/20260922000000_market_chart_focus_broadcast.sql supabase/tests/market_chart_focus_broadcast.sql apps/web/src/features/investing/data/liveBars.ts apps/web/src/features/investing/data/liveBars.test.ts apps/web/src/features/investing/data/supabaseMarket.ts apps/web/src/features/investing/data/supabaseMarket.test.ts apps/web/src/features/investing/data/quoteStream.ts apps/web/src/features/investing/data/quoteStream.test.ts apps/web/src/features/investing/hooks/useQuoteStream.ts apps/web/src/features/investing/hooks/useQuoteStream.test.tsx apps/web/src/features/investing/hooks/useChartFocus.ts apps/web/src/features/investing/hooks/useChartFocus.test.tsx apps/web/src/features/investing/chart/useCandles.ts apps/web/src/features/investing/chart/useCandles.test.tsx apps/web/src/features/investing/InvestingPage.tsx apps/web/src/app/App.test.tsx
git commit -m "fix(investing): close live candle verification gaps"
```

If no correction was required, do not create an empty commit.
