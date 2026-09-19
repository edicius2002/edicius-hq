# Raspberry Pi Collectors and Supabase Data Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all Airfare, X, sentiment, and Investing provider acquisition from the Windows PC to automatically managed Raspberry Pi services, with authenticated browser reads and realtime delivery through Supabase.

**Architecture:** Supabase becomes the owner-document, request/result, health, X, sentiment, and disposable market data plane. The Pi is the only provider-facing runtime; Airfare retains its append-only Pi archive as authority and continues to replicate into Supabase. The browser uses its existing Supabase session and never receives the Pi service-role key.

**Tech Stack:** Python 3.12, FastAPI domain/adapters reused as libraries, httpx, supabase-py 2.31.0, Playwright 1.62.0/Chromium, React 19, TanStack Query, `@supabase/supabase-js`, PostgreSQL/RLS/RPC/Realtime, Debian 13 ARM64, systemd.

**Spec:** `docs/superpowers/specs/2026-09-17-pi-collectors-supabase-design.md`

## Global Constraints

- The Pi runs collectors only and exposes no public HTTP listener.
- `SUPABASE_SECRET_KEY` and the X profile never enter browser code, Git, URLs, reports, or logs.
- Airfare archive means the retained append-only journal; Supabase remains the Airfare replica.
- Every remote write is idempotent and every locally durable cursor advances only after remote acknowledgement.
- Browser access is owner-scoped through `auth.uid()`; service-role writes are explicit grants.
- No automatic `git pull` at boot; deployments activate a pinned commit.
- No PC collector is disabled until its Pi replacement has passed a one-shot production verification.
- Existing PC data is retained untouched for at least seven days after cutover.
- Work occurs in an isolated worktree created with `superpowers:using-git-worktrees` at execution time.
- Each task receives Standards and Spec review before the next task begins.

---

## Delivery map

| Gate                    | Tasks | Independently working result                                  |
| ----------------------- | ----- | ------------------------------------------------------------- |
| A — data plane          | 1–3   | Owner documents, collector tables/RPCs, typed clients, health |
| B — low-risk collectors | 4–5   | Airfare and sentiment run from Pi-compatible commands         |
| C — browser collector   | 6     | X worker/outbox and Dashboard direct read                     |
| D — realtime market     | 7–8   | Investing quotes, bars, and search no longer use PC providers |
| E — operations/cutover  | 9–12  | systemd deployment, migration, verified cutover, rollback     |

Do not parallelize tasks that share a gate. After Gate A, Tasks 4, 5, and 6 may be implemented in parallel worktrees; merge them before Task 7.

### Task 1: Record the architectural change and create the owner-scoped collector schema

**Files:**

- Create: `docs/ADRs/0004-pi-collectors-supabase-data-plane.md`
- Create: `supabase/migrations/20260918000000_collector_data_plane.sql`
- Create: `supabase/tests/collector_data_plane.sql`
- Modify: `apps/web/src/shared/supabase/database.types.ts`

**Interfaces:**

- Produces tables: `edicius_owners`, `app_documents`, `collector_runs`, `tweet_posts`, `sentiment_snapshots`, `market_quotes`, `market_bars`, `collector_requests`.
- Produces RPCs: `write_app_document(text,jsonb,bigint)`, `claim_collector_request(uuid)`, `complete_collector_request(uuid,jsonb)`, `fail_collector_request(uuid,text)`, `read_owner_airfare_history(text,text,text,text[],text,text)`, `read_owner_airfare_calendar(text,text)`, `search_owner_airports(text,int)`.
- `app_documents.document_key` accepts every value in `apps/web/src/shared/storage/keys.ts`.

- [ ] **Step 1: Write the failing database contract test**

```sql
begin;
select plan(8);
select has_table('public', 'app_documents');
select has_table('public', 'collector_requests');
select has_function('public', 'write_app_document', array['text','jsonb','bigint']);
select has_function('public', 'claim_collector_request', array['uuid']);
select policies_are('public', 'market_quotes', array['market_quotes_select_own']);
select policies_are('public', 'collector_requests', array[
  'collector_requests_insert_own', 'collector_requests_select_own'
]);
select results_eq(
  $$select document_key from public.app_documents where false$$,
  $$select null::text where false$$
);
select isnt_empty(
  $$select tablename from pg_publication_tables
    where pubname = 'supabase_realtime' and tablename = 'market_quotes'$$
);
select * from finish();
rollback;
```

- [ ] **Step 2: Run the database test and verify it fails**

Run: `npx supabase db start && npx supabase db reset && npx supabase test db supabase/tests/collector_data_plane.sql`
Expected: FAIL because `app_documents` and collector tables do not exist.

- [ ] **Step 3: Add ADR 0004 with explicit supersession**

```markdown
# ADR 0004 — Raspberry Pi owns provider acquisition

- **Status:** Accepted
- **Date:** 2026-09-18
- **Supersedes:** ADR 0003 sections 1 and 3 only

The Airfare archive remains append-only and authoritative, but its host moves
from the owner's PC to the Raspberry Pi. Supabase remains its indexed replica.
Authenticated browser reads use owner-gated RPCs; collectors write with a
service-role credential stored only on the Pi.
```

Include the authority table and rollback rules verbatim from the design spec. State that ADR 0002 and the remaining ADR 0003 content stay accepted.

- [ ] **Step 4: Implement the migration with explicit grants and RLS**

Use these primary keys and constraints exactly:

```sql
create table public.edicius_owners (
  owner_id uuid primary key references auth.users(id) on delete cascade
);

insert into public.edicius_owners(owner_id)
select distinct owner_id from public.finance_documents on conflict do nothing;

create table public.app_documents (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  document_key text not null check (document_key in (
    'prefs','watchlist','portfolio','alert-rules','greenlight','drawings',
    'indicators','chart-views','airfare-routes','greenlight-projector'
  )),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  revision bigint not null default 1 check (revision > 0),
  updated_at timestamptz not null default now(),
  primary key (owner_id, document_key)
);

create table public.market_quotes (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  symbol text not null,
  provider text not null,
  market_time bigint,
  fetched_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (owner_id, symbol)
);

create table public.market_bars (
  owner_id uuid not null references public.edicius_owners(owner_id) on delete cascade,
  symbol text not null,
  timeframe text not null,
  extended boolean not null,
  provider text not null,
  fetched_at timestamptz not null,
  expires_at timestamptz not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  primary key (owner_id, symbol, timeframe, extended)
);
```

Define `tweet_posts` with primary key `(owner_id, handle, post_id)`, `sentiment_snapshots` with `(owner_id, source, as_of)`, and `collector_runs` with UUID `run_id`, collector/status counters, sanitized `error_code`, and timestamps. Define `collector_requests` with UUID ID, `owner_id uuid not null default auth.uid()`, operation constrained to `market-bars` or `market-search`, object payload/result, `queued|running|complete|failed|expired` status, claim timestamps, and five-minute expiry. Its insert policy must also require `owner_id = auth.uid()` so the browser cannot choose another owner.

`claim_collector_request` must atomically select the oldest unexpired queued row using `for update skip locked`, update it to `running`, and return it. Revoke all by default, then grant only owner selects/inserts and service-role collector writes/RPC execution. Add the four approved tables to `supabase_realtime`.

- [ ] **Step 5: Add owner-gated Airfare wrapper RPCs**

```sql
if auth.uid() is null or not exists (
  select 1 from public.edicius_owners where owner_id = auth.uid()
) then
  raise exception using errcode = '42501', message = 'not_edicius_owner';
end if;
return public.read_airfare_history(
  p_origin, p_destination, p_departure, p_snapshot_months, p_since, p_until
);
```

Apply the same guard to calendar and airport search. Keep underlying Airfare tables and old RPCs service-role-only.

- [ ] **Step 6: Reset, test, generate types, and commit**

Run:

```bash
npx supabase db reset
npx supabase test db supabase/tests/collector_data_plane.sql
npx supabase gen types typescript --local > apps/web/src/shared/supabase/database.types.ts
npm run typecheck
git add docs/ADRs/0004-pi-collectors-supabase-data-plane.md supabase apps/web/src/shared/supabase/database.types.ts
git commit -m "feat: add owner-scoped collector data plane"
```

Expected: database tests, generated types, and TypeScript check pass.

### Task 2: Move shared owner documents from the PC KV API to Supabase

**Files:**

- Create: `apps/web/src/shared/storage/supabaseStorage.ts`
- Create: `apps/web/src/shared/storage/supabaseStorage.test.ts`
- Modify: `apps/web/src/shared/storage/storage.ts`
- Modify: `apps/web/src/shared/storage/useStoredDocument.ts`
- Create: `scripts/app-documents-supabase.py`
- Create: `services/api/tests/test_app_documents_supabase_script.py`
- Modify: `scripts/api.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces `readRemoteDocument<T>(key, signal): Promise<RemoteDocument<T> | null>`.
- Produces `writeRemoteDocument<T>(key, payload, expectedRevision): Promise<RemoteDocument<T>>`.
- Preserves `readStorage`, `writeStorage`, `removeStorage` caller signatures and the serialized edit behavior.
- Migration command: `npm run app-documents:supabase -- --owner-id <uuid> --apply`.

- [ ] **Step 1: Write failing storage conflict tests**

```ts
it('writes through the revision RPC and returns the next revision', async () => {
  rpc.mockResolvedValue({
    data: { document_key: 'watchlist', payload: { version: 1 }, revision: 2 },
    error: null,
  });
  await expect(writeRemoteDocument('watchlist', { version: 1 }, 1)).resolves.toMatchObject({
    revision: 2,
  });
  expect(rpc).toHaveBeenCalledWith('write_app_document', {
    p_document_key: 'watchlist',
    p_payload: { version: 1 },
    p_expected_revision: 1,
  });
});
```

Also test missing documents, `AbortSignal`, and HTTP 409 revision conflicts.

- [ ] **Step 2: Run the focused test and verify it fails**

Run: `npm test -w web -- src/shared/storage/supabaseStorage.test.ts`
Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the typed Supabase storage boundary**

```ts
export type RemoteDocument<T> = {
  key: StorageKey;
  payload: T;
  revision: number;
  updatedAt: string;
};

export async function writeRemoteDocument<T>(
  key: StorageKey,
  payload: T,
  expectedRevision: number,
): Promise<RemoteDocument<T>> {
  const { data, error } = await supabase.rpc('write_app_document', {
    p_document_key: key,
    p_payload: payload as Json,
    p_expected_revision: expectedRevision,
  });
  if (error) throw mapStorageError(error);
  return fromRow<T>(data);
}
```

Change `useStoredDocument` so its query cache holds `{payload, revision}` and each queued write uses the current revision returned by the previous write. Preserve optimistic UI and block writes after a failed read.

- [ ] **Step 4: Add the idempotent local-KV import command**

The command reads `.local-data/kv/*.json`, refuses unknown keys, prints a manifest in dry-run mode, and inserts only when `--apply` is present. It must never print payloads or the service key.

```python
for path in sorted(kv_dir.glob("*.json")):
    key = path.stem
    if key not in ALLOWED_KV_KEYS:
        continue
    client.insert_if_absent(owner_id, key, json.loads(path.read_text(encoding="utf-8")))
```

- [ ] **Step 5: Run focused and full tests, then commit**

Run:

```bash
npm test -w web -- src/shared/storage
cd services/api && .venv/Scripts/python.exe -m pytest tests/test_app_documents_supabase_script.py -q && cd ../..
npm run typecheck
npm run lint
git add apps/web/src/shared/storage scripts/app-documents-supabase.py services/api/tests scripts/api.mjs package.json
git commit -m "feat: store application documents in Supabase"
```

### Task 3: Add the reusable Pi collector cloud boundary and health contract

**Files:**

- Modify: `services/api/requirements.txt`
- Modify: `services/api/app/config.py`
- Create: `services/api/app/services/collector_cloud.py`
- Create: `services/api/tests/test_collector_cloud.py`
- Modify: `.env.example`

**Interfaces:**

- Produces `CollectorConfig(url, secret_key, owner_id, timeout_seconds)`.
- Produces `CollectorCloud.document(key)`, `documents(keys)`, `begin_run(collector)`, `finish_run(run_id, records)`, `fail_run(run_id, code)`, dataset upserts, and request claim/complete/fail.
- Produces immutable `CollectorRequest(id, owner_id, operation, payload, expires_at)` and `configured_collector_cloud()`.
- All errors are `CollectorCloudUnavailable` or `CollectorCloudRejected`; neither contains response bodies, URLs with queries, keys, or payloads.

- [ ] **Step 1: Write failing client safety/idempotency tests**

```python
def test_quote_upsert_uses_owner_symbol_conflict_and_never_authorization(secret_config):
    request = captured_request_for(lambda cloud: cloud.upsert_quotes([QUOTE]))
    assert request.url.params["on_conflict"] == "owner_id,symbol"
    assert request.headers["apikey"] == secret_config.secret_key
    assert "authorization" not in {name.lower() for name in request.headers}
```

Also test redirect rejection, sanitized errors, document 404, request claim RPC, and run status transitions.

- [ ] **Step 2: Run the focused API test and verify it fails**

Run: `cd services/api && .venv/Scripts/python.exe -m pytest tests/test_collector_cloud.py -q`
Expected: FAIL because `collector_cloud` does not exist.

- [ ] **Step 3: Implement the deep HTTP boundary**

Pin `supabase==2.31.0` for Realtime use, but keep Data API writes in this explicit boundary so redirects and logging remain controlled.

```python
@dataclass(frozen=True, slots=True)
class CollectorConfig:
    url: str
    secret_key: str = field(repr=False)
    owner_id: UUID
    timeout_seconds: float = 15.0

class CollectorCloud:
    def document(self, key: str) -> dict[str, Any] | None:
        rows = self._select("app_documents", {"document_key": f"eq.{key}"})
        return None if not rows else _object(rows[0]["payload"], "document payload")

    def documents(self, keys: Sequence[str]) -> dict[str, dict[str, Any]]:
        return {key: value for key in keys if (value := self.document(key)) is not None}

    def upsert_tweets(self, rows: Sequence[dict[str, Any]]) -> int:
        return self._upsert("tweet_posts", rows, "owner_id,handle,post_id")

    def upsert_sentiment(self, row: dict[str, Any]) -> None:
        self._upsert("sentiment_snapshots", [row], "owner_id,source,as_of")

    def upsert_quotes(self, rows: Sequence[dict[str, Any]]) -> int:
        return self._upsert("market_quotes", rows, "owner_id,symbol")

    def upsert_bars(self, row: dict[str, Any]) -> None:
        self._upsert("market_bars", [row], "owner_id,symbol,timeframe,extended")
```

Use allowlisted table/RPC names, `follow_redirects=False`, same-host redirect rejection, fixed conflict targets, and numeric-only success logs.

- [ ] **Step 4: Add fail-closed configuration**

```python
def collector_config() -> CollectorConfig:
    return CollectorConfig(
        url=_required("SUPABASE_URL").rstrip("/"),
        secret_key=_required("SUPABASE_SECRET_KEY"),
        owner_id=UUID(_required("EDICIUS_OWNER_ID")),
        timeout_seconds=_positive_float("COLLECTOR_SUPABASE_TIMEOUT_SECONDS", 15.0),
    )
```

Document only variable names and non-secret examples in `.env.example`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cd services/api && .venv/Scripts/python.exe -m pytest tests/test_collector_cloud.py -q && cd ../..
npm run lint:api
npm run typecheck:api
git add services/api .env.example
git commit -m "feat: add Pi collector cloud boundary"
```

### Task 4: Make Airfare consume the cloud watch and run cleanly on the Pi

**Files:**

- Create: `services/api/app/services/watch_document.py`
- Create: `services/api/tests/fares/test_watch_document.py`
- Modify: `scripts/fares-collect.py`
- Modify: `services/api/tests/fares/test_collect_command.py`
- Create: `apps/web/src/features/airfare/data/supabaseAirfare.ts`
- Create: `apps/web/src/features/airfare/data/supabaseAirfare.test.ts`
- Modify: `apps/web/src/shared/api/fares.ts`
- Modify: `apps/web/src/features/airfare/hooks/useRouteCollection.ts`
- Modify: `apps/web/src/features/airfare/hooks/useHorizonCollection.ts`

**Interfaces:**

- Produces `CloudWatchDocument.load(): dict`, refreshing Supabase and atomically caching to `LOCAL_DATA_DIR/kv/airfare-routes.json`.
- `load()` falls back only to a valid cached document when Supabase is unavailable; a rejected/invalid remote document fails closed.
- Browser history/calendar/search functions preserve existing wire types but call owner-gated Supabase RPCs.

- [ ] **Step 1: Write failing last-known-good watch tests**

```python
def test_unavailable_cloud_uses_valid_cached_watch(tmp_path, cloud):
    cached = tmp_path / "kv/airfare-routes.json"
    write_watch(cached, ROUTES)
    cloud.document.side_effect = CollectorCloudUnavailable("unavailable")
    assert CloudWatchDocument(cloud, cached).load() == ROUTES

def test_invalid_remote_does_not_replace_cache(tmp_path, cloud):
    cached = write_watch(tmp_path / "kv/airfare-routes.json", ROUTES)
    cloud.document.return_value = {"routes": "wrong"}
    with pytest.raises(InvalidWatchDocument): CloudWatchDocument(cloud, cached).load()
    assert read_json(cached) == ROUTES
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd services/api && .venv/Scripts/python.exe -m pytest tests/fares/test_watch_document.py -q`
Expected: FAIL because `CloudWatchDocument` does not exist.

- [ ] **Step 3: Implement the watch seam and connect the existing command**

```python
def load_routes() -> list[dict[str, object]]:
    document = CloudWatchDocument(
        configured_collector_cloud(), kv_dir() / "airfare-routes.json"
    ).load()
    return normalize_routes(document)
```

Do not change collection cadence, append order, ledger, local authority, or incremental sync semantics. Add `--watch-source local|supabase`, defaulting to `supabase`; retain `local` as the rollback switch.

- [ ] **Step 4: Replace browser Airfare reads and manual-start behavior**

```ts
export async function fetchFareHistory(input: FareHistoryInput): Promise<FareHistoryResponse> {
  const { data, error } = await supabase.rpc('read_owner_airfare_history', toRpcArgs(input));
  if (error) throw error;
  return normalizeFareHistory(data);
}
```

History, calendar, and airport search become direct RPC reads. The two collection hooks stop posting to `/api/fares/collect`; they read the latest `collector_runs` row for `airfare` and render it as status. Route edits continue through the `airfare-routes` owner document.

- [ ] **Step 5: Verify Airfare regression coverage and commit**

Run:

```bash
cd services/api && .venv/Scripts/python.exe -m pytest tests/fares -q && cd ../..
npm test -w web -- src/features/airfare src/shared/api/fares.test.ts
npm run typecheck
git add services/api/app/services/watch_document.py services/api/tests/fares scripts/fares-collect.py apps/web/src/features/airfare apps/web/src/shared/api/fares.ts
git commit -m "feat: run Airfare from cloud watch documents"
```

### Task 5: Convert sentiment into a scheduled Pi collector and direct Supabase read

**Files:**

- Create: `scripts/sentiment-collect.py`
- Create: `services/api/tests/test_sentiment_collect_command.py`
- Create: `apps/web/src/features/sentiment/data/supabaseSentiment.ts`
- Create: `apps/web/src/features/sentiment/data/supabaseSentiment.test.ts`
- Modify: `apps/web/src/features/sentiment/hooks/useSentiment.ts`
- Modify: `scripts/api.mjs`
- Modify: `package.json`

**Interfaces:**

- Command `npm run sentiment:collect` exits 0 only after normalized data is stored in Supabase.
- Produces `getLatestSentiment(signal): Promise<SentimentResponse>` from the newest owner row.

- [ ] **Step 1: Write the failing command test**

```python
def test_success_writes_snapshot_and_finishes_run(fake_fetch, cloud):
    code = run_sentiment_pass(fetch=fake_fetch, cloud=cloud)
    assert code == 0
    cloud.upsert_sentiment.assert_called_once()
    cloud.finish_run.assert_called_once_with(ANY, records=1)
```

Test provider failure, invalid payload, and cloud failure; all must mark a sanitized failed run and preserve the prior row.

- [ ] **Step 2: Verify red, implement one-pass command, and verify green**

Run: `cd services/api && .venv/Scripts/python.exe -m pytest tests/test_sentiment_collect_command.py -q`
Expected initially: FAIL.

```python
async def collect_once(cloud: CollectorCloud) -> int:
    run_id = cloud.begin_run("sentiment")
    try:
        snapshot = await fetch_sentiment(httpx.AsyncClient(timeout=UPSTREAM_TIMEOUT_SECONDS))
        cloud.upsert_sentiment(sentiment_row(cloud.owner_id, snapshot))
        cloud.finish_run(run_id, records=1)
        return 0
    except Exception as error:
        cloud.fail_run(run_id, sentiment_error_code(error))
        return 1
```

- [ ] **Step 3: Switch the browser hook to Supabase**

Query `sentiment_snapshots`, ordered by `as_of desc`, limit one, owner RLS implicit. Preserve `SENTIMENT_TTL_SECONDS` as React Query stale time and the existing response normalizer.

- [ ] **Step 4: Verify and commit**

Run:

```bash
cd services/api && .venv/Scripts/python.exe -m pytest tests/test_sentiment_collect_command.py -q && cd ../..
npm test -w web -- src/features/sentiment
npm run typecheck
git add scripts/sentiment-collect.py services/api/tests apps/web/src/features/sentiment scripts/api.mjs package.json
git commit -m "feat: collect sentiment on the Pi data plane"
```

### Task 6: Extract X into a standalone replayable worker and direct Dashboard feed

**Files:**

- Create: `services/api/app/services/tweet_replica.py`
- Create: `services/api/tests/test_tweet_replica.py`
- Create: `scripts/tweets-watch.py`
- Create: `services/api/tests/test_tweets_watch_command.py`
- Modify: `services/api/app/services/tweet_watcher.py`
- Modify: `services/api/app/main.py`
- Create: `apps/web/src/features/dashboard/data/supabaseTweets.ts`
- Create: `apps/web/src/features/dashboard/data/supabaseTweets.test.ts`
- Modify: `apps/web/src/features/dashboard/DashboardPage.tsx`
- Modify: `scripts/api.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces `TweetReplica.replay(handle) -> int` and `append_and_sync(handle, rows) -> int`.
- Cursor file: `LOCAL_DATA_DIR/tweets/<handle>.supabase-cursor.json`, containing acknowledged byte offset and file identity.
- Command `npm run tweets:watch -- --handle thsottiaux` owns the profile until SIGTERM and exits non-zero on fatal session errors.

- [ ] **Step 1: Write failing outbox replay tests**

```python
def test_cursor_advances_only_after_upsert(tmp_path, cloud):
    archive = write_jsonl(tmp_path / "thsottiaux.jsonl", [TWEET_1, TWEET_2])
    cloud.upsert_tweets.side_effect = CollectorCloudUnavailable("offline")
    replica = TweetReplica(archive, cloud)
    with pytest.raises(CollectorCloudUnavailable): replica.replay("thsottiaux")
    assert not replica.cursor_path.exists()
```

Also test retry deduplication, partial final line, archive replacement, batching, and no payload text in errors.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd services/api && .venv/Scripts/python.exe -m pytest tests/test_tweet_replica.py -q`
Expected: FAIL because `TweetReplica` does not exist.

- [ ] **Step 3: Implement local-first record and standalone lifecycle**

```python
async def record(self, handle: str, rows: list[dict[str, Any]]) -> int:
    fresh = self.fresh_rows(handle, rows)
    self._write(handle, fresh)
    await asyncio.to_thread(self.replica.replay, handle)
    for row in fresh: self.stream.write(row)
    return len(fresh)
```

The CLI replays the retained JSONL before opening X, installs SIGINT/SIGTERM handlers, calls `watch(handle)`, waits until stopped, and closes Chromium cleanly. Change `X_TWEET_WATCH_ON_START` default to false and remove implicit watcher startup from `main.py`; the PC API must never become a second profile owner after cutover.

- [ ] **Step 4: Replace Dashboard API/SSE calls with Supabase query/Realtime**

```ts
export function subscribeTweets(handle: string, onInsert: () => void) {
  const channel = supabase
    .channel(`tweets:${handle}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'tweet_posts', filter: `handle=eq.${handle}` },
      onInsert,
    )
    .subscribe();
  return () => {
    void supabase.removeChannel(channel);
  };
}
```

Dashboard queries `tweet_posts` newest-first and `collector_runs` for X status. Remove `startWatch`, refresh polling, and PC SSE behavior from the component.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cd services/api && .venv/Scripts/python.exe -m pytest tests/test_tweet_replica.py tests/test_tweets_watch_command.py tests/test_main.py -q && cd ../..
npm test -w web -- src/features/dashboard
npm run lint:api && npm run typecheck:api && npm run typecheck
git add services/api scripts/tweets-watch.py apps/web/src/features/dashboard scripts/api.mjs package.json
git commit -m "feat: run X watcher as a replayable Pi worker"
```

### Task 7: Build the market worker for watchlist quotes and disposable bars

**Files:**

- Create: `services/api/app/services/market_worker.py`
- Create: `services/api/tests/test_market_worker.py`
- Create: `scripts/market-worker.py`
- Create: `services/api/tests/test_market_worker_command.py`
- Modify: `scripts/api.mjs`
- Modify: `package.json`

**Interfaces:**

- Produces `MarketWorker.refresh_symbols()`, `accept(tick)`, `flush_quotes()`, `serve_request(request)`, and `run(stop_event)`.
- Symbol ownership is the normalized union of watchlist entries, portfolio positions, and active alert symbols.
- Quote flush is coalesced to five seconds per symbol; REST recovery is 60 seconds.

- [ ] **Step 1: Write failing symbol and coalescing tests**

```python
def test_symbols_union_three_documents_without_duplicates(cloud):
    cloud.documents.return_value = {
        "watchlist": {"entries": [{"symbol": "AAPL"}]},
        "portfolio": {"positions": [{"symbol": "BTC-USD"}]},
        "alert-rules": {"alerts": [{"symbol": "AAPL", "active": True}]},
    }
    assert MarketWorker(cloud).desired_symbols() == ("AAPL", "BTC-USD")

def test_many_ticks_flush_one_latest_quote_per_window(worker, cloud, clock):
    worker.accept(TICK_100); worker.accept(TICK_101); clock.advance(5)
    worker.flush_quotes()
    cloud.upsert_quotes.assert_called_once_with([quote(price=101)])
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cd services/api && .venv/Scripts/python.exe -m pytest tests/test_market_worker.py -q`
Expected: FAIL because `MarketWorker` does not exist.

- [ ] **Step 3: Implement market worker using existing provider adapters**

```python
async def serve_request(self, request: CollectorRequest) -> None:
    if request.operation == "market-bars":
        result = await registry.fetch_bars(
            self.client, request.symbol, request.timeframe, extended=request.extended
        )
        self.cloud.upsert_bars(bar_row(self.owner_id, result))
        self.cloud.complete_request(request.id, bars_response(result))
    elif request.operation == "market-search":
        hits = await registry.search(self.client, request.query, limit=10)
        self.cloud.complete_request(request.id, {"results": [symbol_hit_wire(hit) for hit in hits]})
```

Reuse provider parsing, typed errors, session rules, and `CompositeStream`; do not duplicate Yahoo/Binance logic. A failed symbol must not blank successful symbols.

- [ ] **Step 4: Add Realtime request wakeup with polling reconciliation**

Use supabase-py Realtime to subscribe to owner `collector_requests` inserts. On connect and every 30 seconds, call the atomic claim RPC until it returns no work. Reconnect with capped exponential backoff. The polling path is reconciliation, not the main latency path.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cd services/api && .venv/Scripts/python.exe -m pytest tests/test_market_worker.py tests/test_market_worker_command.py -q && cd ../..
npm run lint:api
npm run typecheck:api
git add services/api/app/services/market_worker.py services/api/tests scripts/market-worker.py scripts/api.mjs package.json
git commit -m "feat: add Raspberry Pi market worker"
```

### Task 8: Switch Investing quotes, bars, and search to Supabase

**Files:**

- Create: `apps/web/src/features/investing/data/supabaseMarket.ts`
- Create: `apps/web/src/features/investing/data/supabaseMarket.test.ts`
- Modify: `apps/web/src/shared/api/market.ts`
- Modify: `apps/web/src/features/investing/data/quoteBus.ts`
- Modify: `apps/web/src/features/investing/data/quoteStream.ts`
- Modify: `apps/web/src/features/investing/chart/useCandles.ts`
- Modify: `apps/web/src/features/investing/ui/SymbolSearch.tsx`
- Modify: `apps/web/src/features/investing/InvestingPage.tsx`

**Interfaces:**

- `getQuotes` reads `market_quotes` by symbols.
- `openQuoteStream` subscribes to owner `market_quotes` updates.
- `getBars` returns a fresh `market_bars` row or enqueues `market-bars` and waits for completion.
- `searchSymbols` enqueues `market-search` and waits for completion.
- Request wait has a 20-second deadline and removes its Realtime channel in every terminal path.

- [ ] **Step 1: Write failing request/result and subscription tests**

```ts
it('enqueues a stale bar request and resolves its completed result', async () => {
  barsSelect.mockResolvedValue({ data: [], error: null });
  requestInsert.mockResolvedValue({ data: { id: 'request-1' }, error: null });
  const pending = getBars('AAPL', '1d', false);
  realtime.complete('request-1', BARS_RESPONSE);
  await expect(pending).resolves.toEqual(BARS_RESPONSE);
  expect(requestInsert).toHaveBeenCalledWith(expect.objectContaining({ operation: 'market-bars' }));
});
```

Test owner RLS errors, timeout cleanup, stale cache replacement, quote update mapping, and request failures.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -w web -- src/features/investing/data/supabaseMarket.test.ts`
Expected: FAIL because `supabaseMarket` does not exist.

- [ ] **Step 3: Implement the Supabase market boundary**

```ts
async function enqueue<T>(operation: CollectorOperation, payload: Json): Promise<T> {
  const { data, error } = await supabase
    .from('collector_requests')
    .insert({ operation, payload })
    .select('id')
    .single();
  if (error) throw error;
  return waitForCollectorResult<T>(data.id, 20_000);
}
```

The insert must rely on a database default/trigger for `owner_id = auth.uid()`; never trust a browser-supplied owner ID. Normalize database JSON through the existing `Quote`, `BarsResponse`, and `SymbolHit` types.

- [ ] **Step 4: Remove provider API call paths from Investing**

Keep module exports stable so UI consumers do not learn table shapes. Replace authenticated API SSE with Supabase Realtime and ensure the quote bus still batches initial reads. No `/api/market/*` URL should remain under `apps/web/src/features/investing` or `apps/web/src/shared/api/market.ts`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
npm test -w web -- src/features/investing src/shared/api/market.test.ts
npm run typecheck
npm run lint
rg -n "/api/market" apps/web/src && exit 1 || true
git add apps/web/src/features/investing apps/web/src/shared/api/market.ts
git commit -m "feat: read Investing market data through Supabase"
```

### Task 9: Package pinned Raspberry Pi systemd services and installer

**Files:**

- Create: `ops/pi/systemd/edicius-airfare.service`
- Create: `ops/pi/systemd/edicius-airfare.timer`
- Create: `ops/pi/systemd/edicius-sentiment.service`
- Create: `ops/pi/systemd/edicius-sentiment.timer`
- Create: `ops/pi/systemd/edicius-tweets.service`
- Create: `ops/pi/systemd/edicius-market.service`
- Create: `ops/pi/install.sh`
- Create: `ops/pi/verify.sh`
- Create: `ops/pi/tests/test_units.py`
- Modify: `.gitignore`

**Interfaces:**

- Durable root: `/var/lib/edicius-hq`.
- Secret env: `/etc/edicius-hq/collectors.env` mode `0600`.
- Active release: `/opt/edicius-hq/current` symlink.
- Units run as dedicated `edicius`, use no inbound ports, and are disabled until explicit cutover.

- [ ] **Step 1: Write failing static unit tests**

```python
@pytest.mark.parametrize("unit", UNITS)
def test_units_run_as_edicius_and_wait_for_network(unit):
    text = unit.read_text()
    assert "User=edicius" in text
    assert "After=network-online.target" in text
    assert "EnvironmentFile=/etc/edicius-hq/collectors.env" in text
    assert "Restart=always" in text or unit.suffix == ".timer"
    assert "0.0.0.0" not in text
```

- [ ] **Step 2: Run the unit test and verify failure**

Run: `cd services/api && .venv/Scripts/python.exe -m pytest ../../ops/pi/tests/test_units.py -q`
Expected: FAIL because the units do not exist.

- [ ] **Step 3: Add hardened units and timers**

Airfare and sentiment are `Type=oneshot` services with `flock` and timers:

```ini
[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true
RandomizedDelaySec=30
```

Tweets and market are long-running services with `Restart=on-failure`, `RestartSec=15`, `TimeoutStopSec=60`, `NoNewPrivileges=true`, `PrivateTmp=true`, `ProtectSystem=strict`, and explicit writable paths beneath `/var/lib/edicius-hq`.

- [ ] **Step 4: Implement idempotent install and verification scripts**

`install.sh` must validate Debian ARM64, Python 3.12, the exact commit directory, required env variable names, env mode, Chromium installation, and writable state. It may install files and reload systemd but must not enable services. `verify.sh` runs Airfare dry-run, sentiment one-shot against a test run, X profile cookie presence, market document discovery, and `systemd-analyze verify`.

- [ ] **Step 5: Verify and commit**

Run:

```bash
cd services/api && .venv/Scripts/python.exe -m pytest ../../ops/pi/tests/test_units.py -q && cd ../..
bash -n ops/pi/install.sh ops/pi/verify.sh
git add ops/pi .gitignore
git commit -m "feat: package Raspberry Pi collector services"
```

### Task 10: Add operator migration, deployment, and rollback runbooks

**Files:**

- Create: `docs/pi-collectors-runbook.md`
- Create: `ops/pi/import-x-profile.sh`
- Create: `ops/pi/cutover.ps1`
- Create: `ops/pi/rollback.ps1`
- Create: `ops/pi/tests/test_runbooks.py`

**Interfaces:**

- The runbook separates agent-executable commands from the two human-only actions: installing the secret env file and satisfying X login/MFA.
- `cutover.ps1` validates exact Windows task name `Edicius airfare` before disabling it.
- `rollback.ps1` stops Pi units before re-enabling the Windows task; it never deletes data.

- [ ] **Step 1: Write failing safety tests**

```python
def test_cutover_checks_pi_before_disabling_windows_task():
    text = Path("ops/pi/cutover.ps1").read_text()
    assert text.index("verify.sh") < text.index("Disable-ScheduledTask")
    assert "Edicius airfare" in text
    assert "Remove-Item" not in text
```

- [ ] **Step 2: Implement runbook and scripts**

Document exact sequence: create `/etc/edicius-hq/collectors.env`, deploy pinned commit, install Chromium, copy/import X session, run schema/app-document/X-history migrations, verify disabled units, one-shot each collector, compare Supabase rows, cut over, observe, and rollback. Never put actual credential values in commands or screenshots.

- [ ] **Step 3: Verify and commit**

Run:

```bash
cd services/api && .venv/Scripts/python.exe -m pytest ../../ops/pi/tests/test_runbooks.py -q && cd ../..
git add docs/pi-collectors-runbook.md ops/pi
git commit -m "docs: add Pi collector cutover and rollback runbook"
```

### Task 11: Execute staged production migration and collector cutover

**Files:**

- Create evidence directory at execution time: `docs/pi-collectors-evidence/`
- No secrets or X profile files are committed.

**Interfaces:**

- Produces sanitized evidence: schema verification, source/destination counts, unit status, run IDs, timestamps, and rollback readiness.

- [ ] **Step 1: Apply schema and verify security before data movement**

Run:

```bash
npx supabase db push --linked
npx supabase migration list --linked
npx supabase inspect db table-stats --linked
```

Then run an authenticated production smoke proving owner reads succeed, anon reads fail, and service writes succeed. Save only statuses and counts.

- [ ] **Step 2: Import owner documents and existing X archive**

Run dry-run first, record counts, then apply. Re-run both imports and require zero new rows/changes on the second pass. Do not delete `.local-data/kv` or the PC X JSONL/profile.

- [ ] **Step 3: Deploy disabled Pi units and perform one-shot verification**

Run `ops/pi/install.sh`, `ops/pi/verify.sh`, `ops/pi/verify.sh --live sentiment`, `ops/pi/verify.sh --live x-posts`, and `ops/pi/verify.sh --live market` while every unit remains disabled. Verify the Airfare dry run, completed Sentiment run, X replay/capture and post state, and Market quote/bar/search results in Supabase.

- [ ] **Step 4: Cut over in dependency order**

Order:

1. Enable sentiment timer and observe one success.
2. Stop and confirm the PC X watcher, then enable X service and verify new/replayed post idempotency.
3. Enable market service and verify Realtime plus request turnaround.
4. Stop any running Windows `Edicius airfare` instance, wait for termination, disable and recheck the task, then enable Pi Airfare timer and verify one complete pass/sync.

- [ ] **Step 5: Record 24-hour observation evidence**

Require no duplicate keys, no stale collector heartbeat beyond two expected intervals, no provider traffic from the PC, acceptable market request latency, and no secret-bearing logs. If any gate fails, execute rollback before investigating.

### Task 12: Remove browser dependence on provider-facing PC routes and run final verification

**Files:**

- Modify: `services/api/app/main.py`
- Modify: `services/api/app/routers/market.py`
- Modify: `services/api/app/routers/sentiment.py`
- Modify: `services/api/app/routers/tweets.py`
- Modify: `services/api/app/routers/fares.py`
- Modify: `docs/deploy-plan.md`
- Modify: `CONTEXT.md`
- Modify: relevant tests under `services/api/tests/` and `apps/web/src/`

**Interfaces:**

- PC API may retain explicitly documented local-development routes, but production browser bundles contain no `/api/market`, `/api/sentiment`, `/api/tweets`, or Airfare collection-start calls.
- API startup launches no collector.

- [ ] **Step 1: Add regression tests for zero startup collectors and zero production API paths**

```python
def test_api_lifespan_does_not_start_provider_collectors(monkeypatch):
    monkeypatch.setattr(tweet_watcher.RUNNER, "watch", Mock())
    with TestClient(app): pass
    tweet_watcher.RUNNER.watch.assert_not_called()
```

Add a web source test that rejects the forbidden production route strings.

- [ ] **Step 2: Remove or development-gate obsolete paths**

Keep parsing/adapters imported by Pi commands. Remove only HTTP/startup ownership that production no longer uses. Update docs and glossary with **collector**, **owner document**, and the revised Airfare host/replica wording; do not rename existing Airfare domain terms.

- [ ] **Step 3: Run the complete verification matrix**

Run:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run lint:api
npm run typecheck:api
npm run api:test
npm run build
npx supabase db reset
npx supabase test db
python -m pytest ops/pi/tests -q
```

Expected: every command exits 0. Also run `git diff --check` and confirm no `.env`, X profile, cookie, service key, or generated local data is tracked.

- [ ] **Step 4: Request final code review and commit**

Use `superpowers:requesting-code-review` for separate Standards and Spec reviews against this plan and its design spec. Resolve findings, rerun the complete matrix, then:

```bash
git add services apps docs CONTEXT.md
git commit -m "refactor: retire PC provider collection paths"
```

## Human-only checklist

These are the only steps an agent must not fabricate or bypass:

1. Place `SUPABASE_SECRET_KEY` and `EDICIUS_OWNER_ID` in `/etc/edicius-hq/collectors.env`, then set ownership `root:root` and mode `0600`; systemd reads the file before dropping privileges to `edicius`.
2. Complete X login/MFA once on the Pi when the imported profile is rejected.
3. Confirm the seven-day PC-data retention period has elapsed before separately authorizing cleanup.

## Completion gate

The project is complete only when the Pi has survived a reboot, all four collector health rows advance without the PC, Investing bar/search requests complete through Supabase, the Dashboard receives a tweet through Realtime, an Airfare pass appears in the replica, no Windows collector remains enabled, and the full verification matrix passes on the merged commit.
