# Investing 500 ms Live Broadcast Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver owner-private Investing price ticks from the Pi to the browser in 500 ms micro-batches without using `market_quotes` as a high-frequency event log.

**Architecture:** The Pi coalesces provider ticks and sends one private Supabase Realtime Broadcast batch at most every 500 ms. PostgreSQL retains complete quote snapshots at a 60-second bound for initial load and fallback, while the browser authenticates into `market-quotes:<owner UUID>` and applies validated thin ticks over those snapshots.

**Tech Stack:** Python 3.12, asyncio, httpx 0.28, pytest 9; React 19, TypeScript 7, Supabase JS 2.116, Vitest 5; PostgreSQL, Supabase Realtime Broadcast, RLS, pgTAP; Raspberry Pi systemd deployment.

**Spec:** `docs/superpowers/specs/2026-09-21-investing-500ms-live-broadcast-design.md`

## Global Constraints

- The Raspberry Pi remains the only provider-facing runtime.
- Live publication is capped at one owner-scoped batch per 500 ms and sends nothing when no consumer-visible reading changed.
- The consumer-visible reading is exactly `(price, market_state, extended)`; timestamp-only frames do not trigger Broadcast.
- Live delivery uses the private topic `market-quotes:<owner UUID>` and event `ticks`; authenticated browsers receive only their own topic and cannot publish.
- `market_quotes` remains a replaceable snapshot and receives thin tick merges no more than once per symbol every 60 seconds.
- Full REST quote recovery remains at 60 seconds and keeps currency, previous close, name, and other complete quote metadata.
- A Broadcast failure retains only the newest tick per symbol, never exposes provider or credential details, and does not stop snapshot reconciliation.
- Use the existing `httpx`, `@supabase/supabase-js`, and Realtime dependencies; add no product dependency.
- Preserve the existing snapshot-polling fallback and live latch behavior.

## File Map

- `supabase/migrations/20260921020000_market_quote_broadcast.sql` — private owner-topic read policy and removal of `market_quotes` from Postgres Changes.
- `supabase/tests/market_quote_broadcast.sql` — pgTAP policy role/command/topic and publication assertions.
- `supabase/tests/collector_data_plane.sql` — changes the old publication assertion to prove `market_quotes` is no longer published through Postgres Changes.
- `services/api/app/services/collector_cloud.py` — allowlisted, sanitized private Broadcast REST boundary.
- `services/api/tests/test_collector_cloud.py` — exact URL, topic, event, privacy, payload, and error classification contracts.
- `services/api/app/services/market_worker.py` — 500 ms coalescer, retry state, 60-second snapshot bound, and independently supervised publisher task.
- `services/api/tests/test_market_worker.py` — coalescing, deduplication, retry, scheduling, concurrency, and shutdown regression tests.
- `apps/web/src/features/investing/data/supabaseMarket.ts` — authenticated private Broadcast subscription and untrusted tick decoder.
- `apps/web/src/features/investing/data/supabaseMarket.test.ts` — owner topic, private channel, malformed payload, auth failure, and early-disposal tests.
- `apps/web/src/features/investing/data/quoteStream.ts` — consumes thin tick batches directly and filters to followed symbols.
- `apps/web/src/features/investing/data/quoteStream.test.ts` — direct batch forwarding, filtering, teardown, and terminal-status fallback tests.
- `docs/superpowers/specs/2026-09-17-pi-collectors-supabase-design.md` — records Broadcast as the live path and 60-second PostgreSQL snapshots.
- `docs/pi-collectors-runbook.md` — adds post-deployment checks for Market Broadcast and snapshot cadence.

## Review Focus

- A Broadcast HTTP request that lasts longer than 500 ms must never overlap a second request or lose ticks accepted while it is in flight; Task 3 adds a blocking-boundary test with `max_in_flight == 1` and a second-batch assertion.
- A burst that returns to the last published visible reading within one window must emit no redundant batch; Task 3 tests `100 → 101 → 100` against the last successful reading.
- A session that disappears while `auth.getSession()` is resolving must create no channel and must report a terminal error; Task 4 tests both missing-session and rejected-session paths.
- A mixed Broadcast payload containing valid, malformed, non-finite, and unexpected rows must deliver only the fully valid ticks; Task 4 tests every rejected field class in one literal payload.
- A closed market or quiet provider must cause zero Broadcast requests while the 60-second snapshot loop remains operational; Task 3 runs the publisher through multiple windows with an empty pending map and then reconciles once.

---

### Task 1: Authorize private owner Broadcast topics

**Files:**

- Create: `supabase/migrations/20260921020000_market_quote_broadcast.sql`
- Create: `supabase/tests/market_quote_broadcast.sql`
- Modify: `supabase/tests/collector_data_plane.sql`

**Interfaces:**

- Consumes: Supabase's `realtime.messages`, `realtime.topic()`, `auth.uid()`, and existing `supabase_realtime` publication.
- Produces: policy `market_quote_broadcast_select_own`; private topic contract `market-quotes:<auth.uid()>`; no authenticated Broadcast insert policy; `market_quotes` absent from Postgres Changes publication.

- [ ] **Step 1: Write the failing pgTAP policy and publication tests**

Create `supabase/tests/market_quote_broadcast.sql` with literal catalog assertions:

```sql
begin;
select plan(6);

select is(
  (select cmd from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_quote_broadcast_select_own'),
  'SELECT',
  'market quote Broadcast policy is read-only'
);
select results_eq(
  $$select role_name::text
      from pg_policies, unnest(roles) role_name
     where schemaname = 'realtime' and tablename = 'messages'
       and policyname = 'market_quote_broadcast_select_own'$$,
  $$values ('authenticated')$$,
  'only authenticated clients receive market quote Broadcasts'
);
select like(
  (select qual from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_quote_broadcast_select_own'),
  '%extension%broadcast%',
  'policy is limited to Broadcast messages'
);
select like(
  (select qual from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and policyname = 'market_quote_broadcast_select_own'),
  '%market-quotes:%uid%',
  'policy binds the topic to the authenticated owner'
);
select is(
  (select count(*) from pg_policies
    where schemaname = 'realtime' and tablename = 'messages'
      and cmd = 'INSERT' and 'authenticated' = any(roles)),
  0::bigint,
  'authenticated clients cannot publish Broadcasts'
);
select is(
  (select count(*) from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public' and tablename = 'market_quotes'),
  0::bigint,
  'market quote snapshots are not duplicated through Postgres Changes'
);

select * from finish();
rollback;
```

In `supabase/tests/collector_data_plane.sql`, replace the existing positive `market_quotes` publication assertion with the same zero-count assertion. Keep its pgTAP plan count unchanged because this replaces one assertion.

- [ ] **Step 2: Run the focused database test and verify RED**

Run:

```powershell
npx supabase test db supabase/tests/market_quote_broadcast.sql
```

Expected: FAIL because `market_quote_broadcast_select_own` does not exist and `market_quotes` is still in `supabase_realtime`.

- [ ] **Step 3: Add the migration**

Create `supabase/migrations/20260921020000_market_quote_broadcast.sql`:

```sql
create policy market_quote_broadcast_select_own
on realtime.messages
for select
to authenticated
using (
  realtime.messages.extension = 'broadcast'
  and (select realtime.topic()) = 'market-quotes:' || (select auth.uid())::text
);

alter publication supabase_realtime drop table public.market_quotes;
```

- [ ] **Step 4: Reset the local schema and verify GREEN**

Run:

```powershell
npx supabase db reset
npx supabase test db supabase/tests/market_quote_broadcast.sql
npx supabase test db supabase/tests/collector_data_plane.sql
```

Expected: reset succeeds; both pgTAP files finish with zero failed assertions.

- [ ] **Step 5: Commit the database boundary**

```powershell
git add -- supabase/migrations/20260921020000_market_quote_broadcast.sql supabase/tests/market_quote_broadcast.sql supabase/tests/collector_data_plane.sql
git commit -m "feat(investing): authorize private quote broadcasts"
```

---

### Task 2: Add the Pi-to-Realtime Broadcast cloud boundary

**Files:**

- Modify: `services/api/app/services/collector_cloud.py`
- Modify: `services/api/tests/test_collector_cloud.py`

**Interfaces:**

- Consumes: `CollectorCloud.owner_id`, its configured Supabase project host and secret `apikey`, and `Sequence[Mapping[str, Any]]` tick wires.
- Produces: `CollectorCloud.broadcast_quote_ticks(ticks: Sequence[Mapping[str, Any]]) -> int`, posting one JSON batch to `/realtime/v1/api/broadcast/market-quotes:<owner>/events/ticks?private=true` and returning the accepted tick count.

- [ ] **Step 1: Write failing transport-contract tests**

Add tests to `services/api/tests/test_collector_cloud.py`:

```python
TICKS = [
    {
        "symbol": "AAPL",
        "price": 201.5,
        "marketState": "REGULAR",
        "extended": False,
        "changePercent": 1.25,
        "time": 1790008113.25,
    }
]


def test_quote_broadcast_uses_private_owner_topic_and_one_batch(secret_config):
    request = captured_request_for(
        lambda cloud: cloud.broadcast_quote_ticks(TICKS),
        secret_config,
        httpx.Response(202, json={}),
    )

    assert request.url.path == (
        f"/realtime/v1/api/broadcast/market-quotes:{OWNER_ID}/events/ticks"
    )
    assert request.url.params["private"] == "true"
    assert request.headers["apikey"] == secret_config.secret_key
    assert json.loads(request.content) == {"ticks": TICKS}


def test_empty_quote_broadcast_makes_no_http_request(secret_config):
    requests = []
    cloud = CollectorCloud(
        secret_config,
        transport=httpx.MockTransport(
            lambda request: requests.append(request) or httpx.Response(202, json={})
        ),
    )

    assert cloud.broadcast_quote_ticks([]) == 0
    assert requests == []


@pytest.mark.parametrize(
    ("status", "error"),
    [(429, CollectorCloudUnavailable), (503, CollectorCloudUnavailable),
     (403, CollectorCloudRejected)],
)
def test_quote_broadcast_classifies_remote_failures_without_response_details(
    secret_config, status, error
):
    cloud = CollectorCloud(
        secret_config,
        transport=httpx.MockTransport(
            lambda _: httpx.Response(status, text="private policy detail")
        ),
    )

    with pytest.raises(error) as raised:
        cloud.broadcast_quote_ticks(TICKS)
    assert "private policy detail" not in str(raised.value)
```

- [ ] **Step 2: Run the focused API tests and verify RED**

Run:

```powershell
npm run api:test -- -q tests/test_collector_cloud.py -k "quote_broadcast"
```

Expected: FAIL with `AttributeError: 'CollectorCloud' object has no attribute 'broadcast_quote_ticks'`.

- [ ] **Step 3: Implement the allowlisted Broadcast method**

In `CollectorCloud.__init__`, retain the sanitized project URL:

```python
self._project_url = project_url
```

Add the public boundary:

```python
def broadcast_quote_ticks(self, ticks: Sequence[Mapping[str, Any]]) -> int:
    if not ticks:
        return 0
    payload = [dict(tick) for tick in ticks]
    self._request(
        "POST",
        f"{self._project_url}/realtime/v1/api/broadcast/"
        f"market-quotes:{self._owner_id}/events/ticks",
        body={"ticks": payload},
        params={"private": "true"},
    )
    LOGGER.info("collector cloud quote broadcasts=%d", len(payload))
    return len(payload)
```

Do not add an `Authorization` header or serialize `owner_id` into the payload; ownership is the server-constructed topic.

- [ ] **Step 4: Verify GREEN and the whole cloud-boundary file**

Run:

```powershell
npm run api:test -- -q tests/test_collector_cloud.py
```

Expected: all tests in `test_collector_cloud.py` pass.

- [ ] **Step 5: Commit the Broadcast boundary**

```powershell
git add -- services/api/app/services/collector_cloud.py services/api/tests/test_collector_cloud.py
git commit -m "feat(investing): publish private quote tick batches"
```

---

### Task 3: Schedule changed tick batches every 500 ms

**Files:**

- Modify: `services/api/app/services/market_worker.py`
- Modify: `services/api/tests/test_market_worker.py`

**Interfaces:**

- Consumes: `CollectorCloud.broadcast_quote_ticks(...)` from Task 2; provider `Tick`; existing 30-second reconciliation and 60-second REST recovery.
- Produces: `LIVE_BROADCAST_SECONDS = 0.5`; `MarketWorker.publish_ticks() -> Awaitable[int]`; independent `_publish_ticks(stop_event)` task; database `QUOTE_FLUSH_SECONDS = 60.0`.

- [ ] **Step 1: Write failing coalescing, deduplication, and retry tests**

Add these behavior tests to `services/api/tests/test_market_worker.py`:

```python
def test_live_batch_keeps_only_the_newest_tick_per_symbol():
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    worker.accept(Tick("AAPL", 100, "yahoo", time=1))
    worker.accept(Tick("AAPL", 101, "yahoo", time=2))

    assert asyncio.run(worker.publish_ticks()) == 1
    remote.broadcast_quote_ticks.assert_called_once_with(
        [expect_tick("AAPL", 101, time=2)]
    )


def test_live_batch_omits_a_burst_that_returns_to_the_last_visible_reading():
    remote = cloud()
    worker = MarketWorker(remote, clock=Clock())
    worker.accept(Tick("AAPL", 100, "yahoo", market_state="REGULAR", time=1))
    asyncio.run(worker.publish_ticks())
    remote.broadcast_quote_ticks.reset_mock()
    worker.accept(Tick("AAPL", 101, "yahoo", market_state="REGULAR", time=2))
    worker.accept(Tick("AAPL", 100, "yahoo", market_state="REGULAR", time=3))

    assert asyncio.run(worker.publish_ticks()) == 0
    remote.broadcast_quote_ticks.assert_not_called()


def test_failed_broadcast_retries_only_the_newest_pending_tick():
    remote = cloud()
    remote.broadcast_quote_ticks.side_effect = [
        CollectorCloudUnavailable("offline"),
        1,
    ]
    worker = MarketWorker(remote, clock=Clock())
    worker.accept(Tick("AAPL", 100, "yahoo", time=1))
    assert asyncio.run(worker.publish_ticks()) == 0
    worker.accept(Tick("AAPL", 102, "yahoo", time=2))

    assert asyncio.run(worker.publish_ticks()) == 1
    assert remote.broadcast_quote_ticks.call_args.args[0][0]["price"] == 102


def test_database_tick_snapshots_remain_bounded_to_sixty_seconds():
    remote = cloud()
    clock = Clock()
    worker = MarketWorker(remote, clock=clock)
    worker.accept(Tick("AAPL", 100, "yahoo", time=1))
    worker.flush_quotes()
    clock.advance(59)
    worker.accept(Tick("AAPL", 101, "yahoo", time=2))
    worker.flush_quotes()
    assert remote.merge_quote_ticks.call_count == 1

    clock.advance(1)
    worker.flush_quotes()
    assert remote.merge_quote_ticks.call_count == 2
    assert remote.merge_quote_ticks.call_args.args[0][0]["payload"]["price"] == 101
```

Define the test-only `expect_tick` helper as a literal dictionary builder in the test file; it must not call `tick_wire`, so an incorrect production serializer fails the assertion.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
npm run api:test -- -q tests/test_market_worker.py -k "live_batch or failed_broadcast"
```

Expected: FAIL because `publish_ticks` and `broadcast_quote_ticks` scheduling state do not exist.

- [ ] **Step 3: Implement async publication and visible-reading deduplication**

In `market_worker.py`:

```python
LIVE_BROADCAST_SECONDS = 0.5
QUOTE_FLUSH_SECONDS = 60.0


def _visible_reading(tick: Tick) -> tuple[float, str | None, bool]:
    return (tick.price, tick.market_state, tick.extended)
```

Initialize `_live_pending: dict[str, Tick]` and `_last_broadcast: dict[str, tuple[float, str | None, bool]]`. Make `accept()` update both `_pending` for snapshots and `_live_pending` for Broadcast.

Implement `publish_ticks()` so all map reads and mutations occur on the event-loop thread while only the blocking HTTP request enters a worker thread:

```python
async def publish_ticks(self) -> int:
    candidates = {
        symbol: tick
        for symbol, tick in self._live_pending.items()
        if _visible_reading(tick) != self._last_broadcast.get(symbol)
    }
    for symbol, tick in tuple(self._live_pending.items()):
        if symbol not in candidates and self._live_pending.get(symbol) is tick:
            self._live_pending.pop(symbol, None)
    if not candidates:
        return 0
    rows = [tick_wire(tick) for tick in candidates.values()]
    self._run_stats.seen += len(rows)
    try:
        await asyncio.to_thread(self.cloud.broadcast_quote_ticks, rows)
    except CollectorCloudError as error:
        self._run_stats.failed += len(rows)
        LOGGER.warning("market quote broadcast failed: %s", type(error).__name__)
        return 0
    self._run_stats.written += len(rows)
    for symbol, tick in candidates.items():
        self._last_broadcast[symbol] = _visible_reading(tick)
        if self._live_pending.get(symbol) is tick:
            self._live_pending.pop(symbol, None)
    return len(rows)
```

Import `CollectorCloudError`. Implement `_publish_ticks(stop_event)` with a stop-event wait bounded by `LIVE_BROADCAST_SECONDS`; after each timeout call `publish_ticks()`. Do not call reconciliation from this loop.

- [ ] **Step 4: Verify GREEN for coalescing and retry**

Run the Step 2 command again.

Expected: the three focused tests pass.

- [ ] **Step 5: Write failing scheduling, non-overlap, quiet-market, and shutdown tests**

Add async scenarios that temporarily set `LIVE_BROADCAST_SECONDS = 0.01` with `monkeypatch`:

```python
def test_publisher_runs_without_another_reconciliation(monkeypatch):
    monkeypatch.setattr(market_worker, "LIVE_BROADCAST_SECONDS", 0.01)

    async def scenario():
        remote = cloud()
        remote.broadcast_quote_ticks.side_effect = lambda _rows: stopped.set() or 1
        worker = MarketWorker(remote, stream=IdleStream(), client=Mock())
        worker.reconcile_once = AsyncMock(return_value=True)
        worker.accept(Tick("AAPL", 101, "yahoo", time=2))
        stopped = asyncio.Event()
        await asyncio.wait_for(worker.run(stopped), 0.2)
        assert worker.reconcile_once.await_count == 1
        remote.broadcast_quote_ticks.assert_called_once()

    asyncio.run(scenario())
```

Add a blocking `broadcast_quote_ticks` fake using `threading.Event`: accept a second tick while the first request is blocked, release it, and assert the next batch carries the second tick and `max_in_flight == 1`. Add a quiet-market scenario that crosses three 10 ms windows, asserts no Broadcast call, invokes `reconcile_once()`, and asserts snapshot methods still run. Extend the existing stop test to assert the publisher task exits within 100 ms.

- [ ] **Step 6: Run scheduling tests and verify RED**

Run:

```powershell
npm run api:test -- -q tests/test_market_worker.py -k "publisher or quiet_market or stop_event"
```

Expected: FAIL because `run()` does not yet create or cancel the independent publisher.

- [ ] **Step 7: Supervise the publisher beside the provider consumer**

In `MarketWorker.run()`, create `publisher = asyncio.create_task(self._publish_ticks(stop_event))` beside the existing tick consumer. In `finally`, cancel and await both background tasks before the final snapshot `flush_quotes()`. At the end of each reconciliation wait, call a private helper that invokes `.result()` on either background task if it completed unexpectedly, so programming failures fail the service instead of becoming silent dead tasks. Expected stop cancellation remains suppressed only for `asyncio.CancelledError`.

- [ ] **Step 8: Verify all worker tests GREEN**

Run:

```powershell
npm run api:test -- -q tests/test_market_worker.py tests/test_market_worker_command.py
```

Expected: all Market worker and command tests pass, including the 500 ms scheduler and existing once-mode behavior.

- [ ] **Step 9: Commit the worker cadence**

```powershell
git add -- services/api/app/services/market_worker.py services/api/tests/test_market_worker.py
git commit -m "feat(investing): broadcast changed ticks every 500ms"
```

---

### Task 4: Subscribe the browser to its private tick topic

**Files:**

- Modify: `apps/web/src/features/investing/data/supabaseMarket.ts`
- Modify: `apps/web/src/features/investing/data/supabaseMarket.test.ts`

**Interfaces:**

- Consumes: current Supabase session `session.user.id`; private Broadcast event payload `{ ticks: Json[] }` from Tasks 1–3.
- Produces: `subscribeQuoteTicks(onTicks: (ticks: Tick[]) => void, onStatus?: (status: string) => void): () => void`; strict thin-tick decoder; private channel `market-quotes:<user.id>`.

- [ ] **Step 1: Write failing private-channel and decoder tests**

Extend the hoisted Supabase mock with `auth.getSession`. Replace the Postgres Changes subscription test with:

```typescript
it('joins the authenticated owner private topic and emits only valid ticks', async () => {
  state.getSession.mockResolvedValue({
    data: { session: { user: { id: 'owner-42' } } },
    error: null,
  });
  let receive!: (event: { payload: unknown }) => void;
  state.on.mockImplementation((_kind, _filter, next) => {
    receive = next;
    return { subscribe: state.subscribe };
  });
  const onTicks = vi.fn();
  const close = subscribeQuoteTicks(onTicks);
  await vi.waitFor(() => expect(state.channel).toHaveBeenCalledOnce());

  expect(state.channel).toHaveBeenCalledWith('market-quotes:owner-42', {
    config: { private: true },
  });
  expect(state.on).toHaveBeenCalledWith('broadcast', { event: 'ticks' }, expect.any(Function));
  receive({
    payload: {
      ticks: [
        {
          symbol: 'AAPL',
          price: 201,
          marketState: 'REGULAR',
          extended: false,
          changePercent: 1,
          time: 2,
        },
        {
          symbol: 'BAD',
          price: Number.NaN,
          marketState: null,
          extended: false,
          changePercent: null,
          time: null,
        },
        { symbol: 'NOFLAG', price: 3, marketState: null, changePercent: null, time: 3 },
      ],
    },
  });
  close();

  expect(onTicks).toHaveBeenCalledWith([
    {
      symbol: 'AAPL',
      price: 201,
      marketState: 'REGULAR',
      extended: false,
      changePercent: 1,
      time: 2,
    },
  ]);
  expect(state.removeChannel).toHaveBeenCalledOnce();
});
```

Add tests for: missing session reports `CHANNEL_ERROR` and creates no channel; rejected `getSession()` does the same without leaking error text; calling the disposer before session resolution creates no channel; `SUBSCRIBED`, `TIMED_OUT`, `CHANNEL_ERROR`, and `CLOSED` are forwarded unchanged.

- [ ] **Step 2: Run the adapter test and verify RED**

Run:

```powershell
npm test -w web -- src/features/investing/data/supabaseMarket.test.ts
```

Expected: FAIL because `subscribeQuoteTicks` does not exist and the current adapter subscribes to `postgres_changes`.

- [ ] **Step 3: Implement authenticated private Broadcast subscription**

Import `Tick` as a type from `quoteStream`. Replace `subscribeQuotes` with `subscribeQuoteTicks`. The function returns its disposer synchronously, then resolves `supabase.auth.getSession()` inside a guarded async setup:

```typescript
export function subscribeQuoteTicks(
  onTicks: (ticks: Tick[]) => void,
  onStatus?: (status: QuoteSubscriptionStatus) => void,
): () => void {
  let disposed = false;
  let channel: ReturnType<typeof supabase.channel> | undefined;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (channel) void supabase.removeChannel(channel);
  };
  void supabase.auth.getSession().then(
    ({ data, error }) => {
      if (disposed) return;
      const owner = data.session?.user.id;
      if (error || !owner) {
        onStatus?.('CHANNEL_ERROR');
        return;
      }
      channel = supabase
        .channel(`market-quotes:${owner}`, { config: { private: true } })
        .on('broadcast', { event: 'ticks' }, ({ payload }) => {
          const ticks = ticksFromPayload(payload);
          if (!disposed && ticks.length) onTicks(ticks);
        })
        .subscribe((status) => {
          if (!disposed) onStatus?.(status);
        });
      if (disposed) void supabase.removeChannel(channel);
    },
    () => {
      if (!disposed) onStatus?.('CHANNEL_ERROR');
    },
  );
  return dispose;
}
```

Implement `ticksFromPayload` using `object` and `number`, with an explicit strict decoder so invalid values are rejected rather than converted to null:

```typescript
function tickFromJson(raw: Json): Tick | null {
  const value = object(raw);
  const symbol = typeof value?.symbol === 'string' ? value.symbol.trim().toUpperCase() : '';
  if (
    !value ||
    !symbol ||
    !number(value.price) ||
    typeof value.extended !== 'boolean' ||
    !(value.marketState === null || typeof value.marketState === 'string') ||
    !(value.changePercent === null || number(value.changePercent)) ||
    !(value.time === null || number(value.time))
  )
    return null;
  return {
    symbol,
    price: value.price,
    marketState: value.marketState,
    extended: value.extended,
    changePercent: value.changePercent,
    time: value.time,
  };
}
```

`ticksFromPayload` must require an object containing a `ticks` array and flat-map it through `tickFromJson`. Do not create a `Quote` and do not call `quoteBus`.

- [ ] **Step 4: Verify the adapter GREEN**

Run the Step 2 command again.

Expected: all `supabaseMarket.test.ts` tests pass.

- [ ] **Step 5: Commit the browser data boundary**

```powershell
git add -- apps/web/src/features/investing/data/supabaseMarket.ts apps/web/src/features/investing/data/supabaseMarket.test.ts
git commit -m "feat(investing): subscribe to private quote broadcasts"
```

---

### Task 5: Feed thin Broadcast ticks into the existing live overlay

**Files:**

- Modify: `apps/web/src/features/investing/data/quoteStream.ts`
- Modify: `apps/web/src/features/investing/data/quoteStream.test.ts`

**Interfaces:**

- Consumes: `subscribeQuoteTicks` from Task 4 and its `Tick[]` callback.
- Produces: unchanged public `openQuoteStream(symbols, options) -> () => void`, now forwarding validated thin ticks instead of reconstructing ticks from full `Quote` rows.

- [ ] **Step 1: Rewrite the stream tests for thin tick input and verify RED**

Change the local test `subscribe` callbacks from `(quotes: Quote[])` to `(ticks: Tick[])`. Assert:

```typescript
it('hands on a thin Broadcast batch unchanged', () => {
  const { receive, onTicks } = open();
  const incoming = [tick({ price: 500, time: 200 })];

  receive(incoming);

  expect(onTicks).toHaveBeenCalledWith(incoming);
});

it('filters Broadcast ticks to followed symbols', () => {
  const { receive, onTicks } = open();
  receive([tick({ symbol: 'MSFT' }), tick({ symbol: 'AAPL', price: 320 })]);

  expect(onTicks).toHaveBeenCalledWith([expect.objectContaining({ symbol: 'AAPL', price: 320 })]);
});
```

Keep and adapt the tests for empty symbol sets, `SUBSCRIBED`, terminal status, callback-after-close, and exactly-once teardown. Add a test that a live tick does not call `quoteBus.ingest`, proving incomplete ticks never become cached full quotes.

- [ ] **Step 2: Run the stream test and verify RED**

Run:

```powershell
npm test -w web -- src/features/investing/data/quoteStream.test.ts
```

Expected: at least the thin-batch test fails because current code expects full `Quote[]` and maps them back into ticks.

- [ ] **Step 3: Replace the Postgres-row adapter with direct tick forwarding**

In `quoteStream.ts`, import `subscribeQuoteTicks`, remove the `quoteBus` import, and change the injectable subscribe signature to `(onTicks: (ticks: Tick[]) => void, onStatus: ...) => () => void`. In the callback:

```typescript
const wanted = new Set(symbols.map((symbol) => symbol.trim().toUpperCase()));
const incoming = ticks.filter((tick) => wanted.has(tick.symbol));
if (incoming.length) options.onTicks(incoming);
```

Keep the current terminal status handling and idempotent stop logic unchanged.

- [ ] **Step 4: Verify Investing live-data tests GREEN**

Run:

```powershell
npm test -w web -- src/features/investing/data/supabaseMarket.test.ts src/features/investing/data/quoteStream.test.ts src/features/investing/hooks/useQuoteStream.test.tsx
```

Expected: all adapter, stream, and hook tests pass.

- [ ] **Step 5: Commit the live overlay integration**

```powershell
git add -- apps/web/src/features/investing/data/quoteStream.ts apps/web/src/features/investing/data/quoteStream.test.ts
git commit -m "feat(investing): apply broadcast ticks to live prices"
```

---

### Task 6: Document, verify, and prepare production rollout

**Files:**

- Modify: `docs/superpowers/specs/2026-09-17-pi-collectors-supabase-design.md`
- Modify: `docs/pi-collectors-runbook.md`

**Interfaces:**

- Consumes: Tasks 1–5 and the deployment workflow already documented in `docs/pi-collectors-runbook.md`.
- Produces: operator-visible cadence and rollback checks; a branch proven by the complete repository gates.

- [ ] **Step 1: Update the architecture and runbook**

Replace the old statement that provider ticks update Supabase rows every five seconds with:

```markdown
Provider ticks are coalesced into one owner-private Realtime Broadcast batch at
most every 500 ms. `market_quotes` is a complete recovery snapshot updated no
more than once per symbol every 60 seconds and is not in the Postgres Changes
publication.
```

Add a Market rollout section to `docs/pi-collectors-runbook.md` with these exact checks:

```text
1. Confirm edicius-market.service is enabled and active on the Pi.
2. Confirm the deployed commit equals the merged commit.
3. Open Investing and verify the Realtime channel reaches SUBSCRIBED.
4. During an active provider move, verify the visible tick arrives within the
   500 ms publication window plus network latency.
5. Query market_quotes twice 10 seconds apart and verify fetched_at does not
   advance from live ticks; repeat after 60–90 seconds and verify a complete
   snapshot advances.
6. Check Supabase Realtime errors and Disk IO after rollout. Roll back the Pi
   release if private-channel joins fail or snapshot freshness exceeds 90 seconds.
```

- [ ] **Step 2: Run formatting and static checks**

Run:

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run lint:api
npm run typecheck:api
git diff --check
```

Expected: every command exits 0 with no formatting, lint, type, or whitespace errors.

- [ ] **Step 3: Run full automated suites**

Run:

```powershell
npm run api:test
npm test
& 'services/api/.venv/Scripts/python.exe' -B -m pytest ops/pi/tests -q -p no:cacheprovider
npx supabase test db
npm run build
```

Expected: API, web, Pi, and pgTAP suites report zero failures; the production web build exits 0.

- [ ] **Step 4: Verify the diff against the approved spec**

Run:

```powershell
git diff --stat a1536a9...HEAD
git diff --check a1536a9...HEAD
git status --short --branch
```

Expected: only the files listed in this plan are changed; no untracked probes or secrets; whitespace check exits 0.

- [ ] **Step 5: Commit documentation and any verification-only fixes**

```powershell
git add -- docs/superpowers/specs/2026-09-17-pi-collectors-supabase-design.md docs/pi-collectors-runbook.md
git commit -m "docs(investing): operate 500ms live quote broadcasts"
```

- [ ] **Step 6: Review, PR, merge, migrate, deploy, and verify**

Use `superpowers:requesting-code-review` for one fresh whole-branch review. Fix every Critical or Important finding test-first, rerun Step 2 and Step 3, then use `superpowers:finishing-a-development-branch`. Create a PR from `fix/investing-500ms-live-broadcast`, wait for required checks, merge it, apply migrations to the linked Supabase project, and deploy the exact merge commit to the Pi using the existing pinned-release wizard. Run the six runbook checks from Step 1 and retain only sanitized evidence; delete every temporary probe locally and on the Pi.
