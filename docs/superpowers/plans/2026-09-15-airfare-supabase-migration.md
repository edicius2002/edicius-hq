# Airfare Supabase Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Supabase the indexed read store and verified cloud replica for Airfare's durable history while collection and its lossless local journal remain on the owner's PC.

**Architecture:** A deep `AirfareData` module owns local/Supabase selection, fallback, synchronization, manifests, and domain mapping. Existing `FareHistory` and `FareCalendar` remain the local write path; an internal PostgREST adapter uploads content-addressed records and calls SQL functions that return bounded, ordered history and calendar documents.

**Tech Stack:** Python 3.12, FastAPI 0.141.1, Pydantic, httpx 0.28.1 with `MockTransport`, pytest 9.1.1, Supabase CLI 2.105.0, PostgreSQL, PostgREST/Data API, pgTAP, React 19, TypeScript, TanStack Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-15-airfare-supabase-migration-design.md`

## Global Constraints

- Project ref is exactly `abndifkxpfppmllgxfnu`; project name is `edicius-hq`.
- Google Flights requests continue to originate from `services/api` on the owner's PC.
- Do not delete, truncate, rename, or rewrite anything under `services/api/.local-data`.
- `SUPABASE_SECRET_KEY` is server-only, is sent only in the `apikey` header, and must never appear in source, browser bundles, logs, command output, test snapshots, or reports.
- RLS is enabled and `anon`/`authenticated` privileges are revoked on every Airfare table and stored function.
- The default configuration remains local and all tests use temporary data plus mocked HTTP; no automated test contacts the live project.
- Preserve all existing Airfare wire semantics except the approved `snapshotMonth` narrowing and added `pairReference` field.
- Keep `AIRFARE_DATA_BACKEND=local` as a one-restart rollback.
- Do not migrate other KV documents, other pages, authentication, backups, static catalogs, collector state, spend, passes, locks, or SSE state.
- Do not use hardware acceleration.

---

## File map

**Create:**

- `supabase/config.toml` — committed local Supabase configuration without secrets.
- `supabase/migrations/20260915000000_airfare_archive.sql` — tables, indexes, grants, RLS, manifests, and read functions.
- `supabase/tests/airfare_archive.test.sql` — pgTAP schema, privilege, idempotency, history, pair-reference, and calendar-horizon tests.
- `services/api/app/services/airfare_supabase.py` — internal Data API adapter and typed external failures.
- `services/api/app/services/airfare_sync.py` — canonical record codec, local-source cursor, batching, upload, and manifest comparison.
- `services/api/app/services/airfare_data.py` — deep interface used by routers for reads/fallback and by jobs for incremental sync.
- `services/api/tests/fares/test_airfare_supabase.py` — mocked transport contract.
- `services/api/tests/fares/test_airfare_sync.py` — content identity, cursor, retry, and manifest tests.
- `services/api/tests/fares/test_airfare_data.py` — local/cloud parity and fallback tests.
- `scripts/fares-supabase.py` — dry-run, apply, verify, and read-parity command.
- `docs/ADRs/0003-airfare-supabase-read-store.md` — durable architecture decision and rollback.
- `docs/airfare-supabase-backfill-report.json` — non-secret, machine-readable migration evidence produced by the verified run.
- `docs/airfare-supabase-results.md` — parity and latency report.

**Modify:**

- `.gitignore` — ignore Supabase CLI state while keeping config/migrations/tests.
- `.env.example` — document URL, secret, sync/read flags, timeout, and batch size.
- `services/api/app/config.py` — parse and validate Airfare Supabase configuration.
- `services/api/app/main.py` — close the reusable Supabase client during lifespan shutdown.
- `services/api/app/routers/fares.py` — consume `AirfareData`, accept `snapshotMonth`, return `pairReference`, and sync imports.
- `services/api/app/services/collection_job.py` — invoke non-fatal incremental sync after completed board work.
- `services/api/app/services/calendar_job.py` — invoke non-fatal incremental sync after completed calendar work.
- `services/api/tests/fares/test_fares_endpoint.py` — bounded history response and pair-reference contract.
- `services/api/tests/test_fares_watch_transfer.py` — import/export behavior across the new read seam.
- `services/api/tests/test_fares_calendar_collect.py` — calendar sync integration.
- `scripts/api.mjs` and `package.json` — expose the migration command through the repository's Python launcher.
- `apps/web/src/shared/api/fares.ts` — request watched months and model the returned pair reference.
- `apps/web/src/features/airfare/hooks/useFareHistory.ts` — include watched months in query key and request.
- `apps/web/src/features/airfare/AirfarePage.tsx` — use the server summary instead of whole-pair raw snapshots.
- `apps/web/src/features/airfare/lib/pairReference.ts` — turn a server summary into the dated display model.
- `apps/web/src/features/airfare/lib/pairReference.test.ts` and `apps/web/src/features/airfare/hooks/useFareHistory.test.tsx` — new contract coverage.
- `docs/deploy-plan.md` and `docs/ADRs/0002-airfare-price-history-store.md` — link the new decision without rewriting the historical rationale.

---

### Task 1: Version and Test the Supabase Schema

**Files:**

- Create: `supabase/config.toml`
- Create: `supabase/migrations/20260915000000_airfare_archive.sql`
- Create: `supabase/tests/airfare_archive.test.sql`
- Modify: `.gitignore`

**Interfaces:**

- Consumes: Supabase CLI 2.105.0 and PostgreSQL JSONB/date/window functions.
- Produces: content-addressed Airfare tables plus `read_airfare_history`, `read_airfare_calendar`, and `airfare_dataset_manifest` RPCs callable only by `service_role`.

- [ ] **Step 1: Initialize the committed local project skeleton**

Run from the repository root:

```powershell
supabase init
```

Keep `supabase/config.toml`. Add these exact ignore entries if the CLI did not create
them:

```gitignore
supabase/.temp/
supabase/.branches/
```

- [ ] **Step 2: Write failing pgTAP tests for shape and privileges**

Create `supabase/tests/airfare_archive.test.sql` with assertions for all six data tables,
the import-run table, primary keys, required indexes, RLS, revoked public privileges,
and the three stored functions. Seed two snapshots on two departure dates whose
cheapest-ever prices are 100 and 300 and assert `pairReference.value = 200` and
`pairReference.dates = 2`. Seed an older long calendar curve plus a newer short curve
and assert the horizon keeps the newer near boundary and older far coverage with each
point's own `observedAt`.

Use this executable fixture and assertion set after the initial shape assertions:

```sql
begin;
select plan(23);

select has_table('public', 'fare_snapshots');
select has_table('public', 'fare_baseline_points');
select has_table('public', 'fare_calendar_captures');
select has_table('public', 'fare_checks');
select has_table('public', 'fare_airports');
select has_table('public', 'airfare_documents');
select has_table('public', 'airfare_import_runs');

select is(
  (select relrowsecurity from pg_class where oid = 'public.fare_snapshots'::regclass),
  true,
  'fare snapshots have RLS enabled'
);
select is(
  has_table_privilege('anon', 'public.fare_snapshots', 'select'),
  false,
  'anon cannot read fare snapshots'
);
select is(
  has_table_privilege('authenticated', 'public.fare_snapshots', 'select'),
  false,
  'authenticated cannot read fare snapshots'
);

select has_function('public', 'read_airfare_history');
select has_function('public', 'read_airfare_calendar');
select has_function('public', 'airfare_dataset_manifest');

insert into public.fare_snapshots
  (record_id, origin, destination, flight_date, captured_at, captured_at_text,
   source, currency, cheapest_price, payload)
values
  (repeat('a', 64), 'AQP', 'LIM', '2027-03-01', '2026-09-01T00:00:00Z',
   '2026-09-01T00:00:00+00:00', 'google-flights', 'USD', 100,
   '{"capturedAt":"2026-09-01T00:00:00+00:00","source":"google-flights","origin":"AQP","destination":"LIM","flightDate":"2027-03-01","returnDate":null,"currency":"USD","insights":null,"offers":[{"price":150},{"price":100}]}'::jsonb),
  (repeat('b', 64), 'AQP', 'LIM', '2027-04-01', '2026-09-02T00:00:00Z',
   '2026-09-02T00:00:00+00:00', 'google-flights', 'USD', 300,
   '{"capturedAt":"2026-09-02T00:00:00+00:00","source":"google-flights","origin":"AQP","destination":"LIM","flightDate":"2027-04-01","returnDate":null,"currency":"USD","insights":null,"offers":[{"price":300}]}'::jsonb);

insert into public.fare_baseline_points
  (record_id, origin, destination, flight_date, price_date, price, currency, source, payload)
values
  (repeat('c', 64), 'AQP', 'LIM', '2027-03-01', '2026-09-01', 120, 'USD',
   'google-flights',
   '{"flightDate":"2027-03-01","date":"2026-09-01","price":120,"currency":"USD","source":"google-flights"}'::jsonb);

insert into public.fare_checks
  (record_id, kind, origin, destination, flight_date, checked_at, outcome, offers, payload)
values
  (repeat('d', 64), 'board', 'AQP', 'LIM', '2027-03-01',
   '2026-09-01T00:00:00Z', 'changed', 2,
   '{"at":"2026-09-01T00:00:00+00:00","flightDate":"2027-03-01","outcome":"changed","offers":2}'::jsonb);

insert into public.fare_airports
  (code, name, city, country, latitude, longitude, payload)
values
  ('AQP', 'Rodríguez Ballón', 'Arequipa', 'Peru', -16.3411, -71.5831,
   '{"code":"AQP","name":"Rodríguez Ballón","city":"Arequipa","country":"Peru","latitude":-16.3411,"longitude":-71.5831}'::jsonb);

insert into public.fare_calendar_captures
  (record_id, origin, destination, captured_at, from_date, to_date, source, currency, payload)
values
  (repeat('e', 64), 'AQP', 'LIM', '2026-09-01T00:00:00Z', '2026-10-01',
   '2027-09-01', 'google-flights', 'USD',
   '{"capturedAt":"2026-09-01T00:00:00+00:00","source":"google-flights","origin":"AQP","destination":"LIM","currency":"USD","from":"2026-10-01","to":"2027-09-01","prices":[{"departureDate":"2027-09-01","price":500}]}'::jsonb),
  (repeat('f', 64), 'AQP', 'LIM', '2026-09-02T00:00:00Z', '2026-10-02',
   '2027-03-01', 'google-flights', 'USD',
   '{"capturedAt":"2026-09-02T00:00:00+00:00","source":"google-flights","origin":"AQP","destination":"LIM","currency":"USD","from":"2026-10-02","to":"2027-03-01","prices":[{"departureDate":"2026-10-02","price":null},{"departureDate":"2027-03-01","price":400}]}'::jsonb);

create temporary table history_result as
select public.read_airfare_history(
  'AQP', 'LIM', '2027-03', array['2027-03'], null, null
) as body;

select is((body->'pairReference'->>'value')::numeric, 200::numeric,
          'pair reference is median of per-departure minima') from history_result;
select is((body->'pairReference'->>'dates')::integer, 2,
          'pair reference counts every priced departure') from history_result;
select is(jsonb_array_length(body->'snapshots'), 1,
          'snapshot month bounds the returned payload') from history_result;
select is(jsonb_array_length(body->'baseline'), 1,
          'departure prefix bounds baseline') from history_result;
select is((body->'health'->>'checks')::integer, 1,
          'health is aggregated from checks') from history_result;
select is(jsonb_array_length(body->'airports'), 1,
          'route airports are returned') from history_result;

create temporary table calendar_result as
select public.read_airfare_calendar('AQP', 'LIM') as body;

select is(body->'horizon'->>'fromDate', '2026-10-02',
          'newest curve supplies near boundary') from calendar_result;
select is(body->'horizon'->>'toDate', '2027-09-01',
          'furthest curve supplies far boundary') from calendar_result;
select is(
  (select point->>'observedAt'
   from calendar_result,
        jsonb_array_elements(body->'horizon'->'prices') point
   where point->>'departureDate' = '2027-09-01'),
  '2026-09-01T00:00:00+00:00',
  'inherited far price retains its observation time'
);
select ok(
  (select point ? 'price' and point->'price' = 'null'::jsonb
   from calendar_result,
        jsonb_array_elements(body->'horizon'->'prices') point
   where point->>'departureDate' = '2026-10-02'),
  'newer explicit null is not overwritten by an older fare'
);

select * from finish();
rollback;
```

- [ ] **Step 3: Run the schema test and confirm the missing-schema failure**

```powershell
supabase start
supabase test db
```

Expected: pgTAP fails because `fare_snapshots` and the RPCs do not exist.

- [ ] **Step 4: Implement the migration**

Create `supabase/migrations/20260915000000_airfare_archive.sql` with:

```sql
create table public.fare_snapshots (
  record_id text primary key check (record_id ~ '^[0-9a-f]{64}$'),
  origin text not null check (origin ~ '^[A-Z0-9]{3}$'),
  destination text not null check (destination ~ '^[A-Z0-9]{3}$'),
  flight_date date not null,
  captured_at timestamptz not null,
  captured_at_text text not null,
  source text not null,
  currency text not null,
  cheapest_price numeric,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz not null default now()
);

create index fare_snapshots_route_flight_capture_idx
  on public.fare_snapshots (origin, destination, flight_date, captured_at);
create index fare_snapshots_route_capture_idx
  on public.fare_snapshots (origin, destination, captured_at);

create table public.fare_baseline_points (
  record_id text primary key check (record_id ~ '^[0-9a-f]{64}$'),
  origin text not null check (origin ~ '^[A-Z0-9]{3}$'),
  destination text not null check (destination ~ '^[A-Z0-9]{3}$'),
  flight_date date not null,
  price_date date not null,
  price numeric not null,
  currency text not null,
  source text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz not null default now()
);
create index fare_baseline_route_flight_price_date_idx
  on public.fare_baseline_points (origin, destination, flight_date, price_date);

create table public.fare_calendar_captures (
  record_id text primary key check (record_id ~ '^[0-9a-f]{64}$'),
  origin text not null check (origin ~ '^[A-Z0-9]{3}$'),
  destination text not null check (destination ~ '^[A-Z0-9]{3}$'),
  captured_at timestamptz not null,
  from_date date not null,
  to_date date not null,
  source text not null,
  currency text not null,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz not null default now()
);
create index fare_calendar_route_capture_idx
  on public.fare_calendar_captures (origin, destination, captured_at desc);

create table public.fare_checks (
  record_id text primary key check (record_id ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('board', 'calendar')),
  origin text not null check (origin ~ '^[A-Z0-9]{3}$'),
  destination text not null check (destination ~ '^[A-Z0-9]{3}$'),
  flight_date date,
  checked_at timestamptz not null,
  outcome text not null,
  offers integer not null default 0 check (offers >= 0),
  cheapest numeric,
  error_code text,
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  imported_at timestamptz not null default now(),
  check ((kind = 'board' and flight_date is not null) or kind = 'calendar')
);
create index fare_checks_board_health_idx
  on public.fare_checks (kind, origin, destination, flight_date, checked_at);
create index fare_checks_calendar_health_idx
  on public.fare_checks (kind, origin, destination, checked_at);

create table public.fare_airports (
  code text primary key check (code ~ '^[A-Z0-9]{3}$'),
  name text,
  city text,
  country text,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  replicated_at timestamptz not null default now()
);

create table public.airfare_documents (
  key text primary key check (key = 'airfare-routes'),
  value jsonb not null,
  source_updated_at timestamptz not null,
  replicated_at timestamptz not null default now()
);

create table public.airfare_import_runs (
  run_id uuid primary key,
  mode text not null check (mode in ('full', 'incremental')),
  started_at timestamptz not null,
  completed_at timestamptz,
  status text not null check (status in ('running', 'complete', 'failed')),
  source_manifest jsonb not null default '{}'::jsonb,
  destination_manifest jsonb not null default '{}'::jsonb,
  error text
);
```

In the same migration, create the three SQL functions with explicit `order by` inside
every `jsonb_agg`. `read_airfare_history` accepts normalized route codes,
`p_departure text`, `p_snapshot_months text[]`, `p_since text`, and `p_until text`.
It returns snapshot payloads, baseline payloads, health counts, route airports, and:

```sql
with per_departure as (
  select flight_date, min(cheapest_price) as price
  from public.fare_snapshots
  where origin = p_origin
    and destination = p_destination
    and cheapest_price is not null
  group by flight_date
)
select jsonb_build_object(
  'value', percentile_cont(0.5) within group (order by price),
  'dates', count(*)
)
from per_departure;
```

Enable RLS on all seven tables, revoke all table and sequence privileges from `anon`
and `authenticated`, grant only required table/function privileges to `service_role`,
and revoke function execution from `public`, `anon`, and `authenticated`.

- [ ] **Step 5: Run schema tests from a clean local database**

```powershell
supabase db reset
supabase test db
```

Expected: all 18 pgTAP assertions pass.

- [ ] **Step 6: Commit the schema slice**

```powershell
git add -- .gitignore supabase/config.toml supabase/migrations/20260915000000_airfare_archive.sql supabase/tests/airfare_archive.test.sql
git commit -m "feat(airfare): define secured Supabase archive schema"
```

### Task 2: Add Safe Supabase Configuration and Transport

**Files:**

- Modify: `.env.example`
- Modify: `services/api/app/config.py`
- Modify: `services/api/app/main.py`
- Create: `services/api/app/services/airfare_supabase.py`
- Create: `services/api/tests/fares/test_airfare_supabase.py`
- Modify: `services/api/tests/test_main.py`

**Interfaces:**

- Consumes: `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `AIRFARE_DATA_BACKEND`, `AIRFARE_SYNC_ENABLED`, `AIRFARE_SUPABASE_TIMEOUT_SECONDS`, and `AIRFARE_SUPABASE_BATCH_SIZE`.
- Produces: `SupabaseAirfare.upsert(table, rows, on_conflict)`, `rpc(name, params)`, `close()`, and typed `AirfareRemoteUnavailable` / `AirfareRemoteRejected` errors; callers never construct HTTP requests.

- [ ] **Step 1: Write failing configuration and transport tests**

Use `httpx.MockTransport` to assert:

```python
def test_secret_uses_only_apikey_header(monkeypatch):
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen.update(request.headers)
        return httpx.Response(200, json=[])

    client = SupabaseAirfare(
        "https://example.supabase.co",
        "sb_secret_example",
        transport=httpx.MockTransport(handler),
    )
    client.upsert("fare_snapshots", [SNAPSHOT_ROW], on_conflict="record_id")
    assert seen["apikey"] == "sb_secret_example"
    assert "authorization" not in seen
```

Also assert HTTPS/project-host validation, missing-variable failures only when cloud
features are enabled, JSON request bodies, `Prefer: resolution=merge-duplicates`, RPC
paths, timeout/429/5xx mapping to `AirfareRemoteUnavailable`, other 4xx mapping to
`AirfareRemoteRejected`, bounded response excerpts without headers, explicit client
close, and FastAPI lifespan shutdown closing the configured client once.

- [ ] **Step 2: Run the focused tests and verify imports fail**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_airfare_supabase.py
```

Expected: collection fails because `app.services.airfare_supabase` does not exist.

- [ ] **Step 3: Add exact environment defaults**

Append to `.env.example`:

```dotenv
# Server-only Supabase access for the Airfare archive. Never prefix the secret with VITE_.
SUPABASE_URL=https://abndifkxpfppmllgxfnu.supabase.co
# SUPABASE_SECRET_KEY=sb_secret_replace_in_ignored_dotenv
AIRFARE_DATA_BACKEND=local
AIRFARE_SYNC_ENABLED=false
AIRFARE_SUPABASE_TIMEOUT_SECONDS=15
AIRFARE_SUPABASE_BATCH_SIZE=250
```

Add typed configuration readers that accept only `local|supabase`, positive timeout,
and batch size `1..500`. Calling the local backend path must not read or validate the
secret.

- [ ] **Step 4: Implement the internal HTTP adapter**

Implement one reusable `httpx.Client` with base URL
`{SUPABASE_URL}/rest/v1`, `apikey`, JSON accept/content headers, and no Authorization
header. Reject redirects to a different host. Redact headers and URLs from all error
messages. `upsert` posts arrays to `/{table}?on_conflict={on_conflict}`; `rpc` posts the
parameter object to `/rpc/{name}`. Register `close()` in `app.main.lifespan` beside the
existing long-lived HTTP client cleanup.

- [ ] **Step 5: Run focused tests and static checks**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_airfare_supabase.py services/api/tests/test_main.py
npm run lint:api
npm run typecheck:api
```

Expected: all commands pass.

- [ ] **Step 6: Commit the transport slice**

```powershell
git add -- .env.example services/api/app/config.py services/api/app/main.py services/api/app/services/airfare_supabase.py services/api/tests/fares/test_airfare_supabase.py services/api/tests/test_main.py
git commit -m "feat(airfare): add secured Supabase transport"
```

### Task 3: Build the Idempotent Local-to-Cloud Synchronizer

**Files:**

- Create: `services/api/app/services/airfare_sync.py`
- Create: `services/api/tests/fares/test_airfare_sync.py`
- Create: `scripts/fares-supabase.py`
- Modify: `scripts/api.mjs`
- Modify: `package.json`

**Interfaces:**

- Consumes: an immutable source root, `SupabaseAirfare`, and `SyncMode = Literal['full', 'incremental']`.
- Produces: `canonical_record_id(kind, origin, destination, row) -> str`, `AirfareSync.scan(mode) -> SourceManifest`, `apply(mode) -> SyncReport`, and `verify(source) -> VerificationReport`.

Use these exact result shapes across the command and deep data module:

```python
@dataclass(frozen=True, slots=True)
class CountDigest:
    records: int
    digest: str

@dataclass(frozen=True, slots=True)
class DatasetManifest:
    physical_valid: int
    logical_unique: int
    skipped: int
    digest: str
    by_route: dict[str, CountDigest]

@dataclass(frozen=True, slots=True)
class SourceManifest:
    snapshots: DatasetManifest
    baseline: DatasetManifest
    calendar: DatasetManifest
    board_checks: DatasetManifest
    calendar_checks: DatasetManifest
    airports: DatasetManifest
    documents: DatasetManifest

@dataclass(frozen=True, slots=True)
class DestinationManifest:
    snapshots: CountDigest
    baseline: CountDigest
    calendar: CountDigest
    board_checks: CountDigest
    calendar_checks: CountDigest
    airports: CountDigest
    documents: CountDigest

@dataclass(frozen=True, slots=True)
class SyncReport:
    mode: Literal["full", "incremental"]
    status: Literal["complete", "failed"]
    source: SourceManifest
    uploaded: dict[str, int]
    error: str | None

@dataclass(frozen=True, slots=True)
class VerificationReport:
    matches: bool
    source: SourceManifest
    destination: DestinationManifest
    mismatches: tuple[str, ...]
```

- [ ] **Step 1: Write failing codec and source-manifest tests**

Build a temporary fixture with one valid and one corrupt line for each JSONL kind, an
explicit-null calendar price, `airports.json`, and `airfare-routes.json`. Assert:

```python
assert canonical_record_id("snapshot", "AQP", "LIM", {"b": 2, "a": "á"}) == canonical_record_id(
    "snapshot", "AQP", "LIM", {"a": "á", "b": 2}
)
assert manifest.snapshots.physical_valid == 1
assert manifest.snapshots.logical_unique == 1
assert manifest.snapshots.skipped == 1
assert manifest.calendar.physical_valid == 1
```

Assert the source tree's hashes are identical before and after dry-run scanning.

- [ ] **Step 2: Write failing cursor and retry tests**

Use a fake `SupabaseAirfare` to prove a batch failure leaves the byte cursor unchanged,
a successful retry advances it exactly to the final newline, a partial trailing line is
not acknowledged, truncation resets to zero, and replay uploads the same record IDs.
Run `apply(full)` twice and assert the fake destination's logical count is unchanged on
the second run.

- [ ] **Step 3: Run focused tests and confirm the module is absent**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_airfare_sync.py
```

Expected: import failure for `app.services.airfare_sync`.

- [ ] **Step 4: Implement canonical rows and manifests**

Use exactly:

```python
def canonical_record_id(
    kind: str,
    origin: str,
    destination: str,
    row: Mapping[str, object],
) -> str:
    body = json.dumps(
        row,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    route = f"{origin.upper()}-{destination.upper()}"
    return hashlib.sha256(f"{kind}\n{route}\n{body}".encode()).hexdigest()
```

Map filenames to normalized route keys with the existing `route_stem` rules. Store the
unaltered parsed row as `payload`; calculate only typed index fields and
`cheapest_price`. Sort record IDs before computing each manifest digest.

- [ ] **Step 5: Implement acknowledged byte cursors and batched upserts**

Write cursors atomically to `.local-data/fares/sync/cursors.json`. For JSONL, open in
binary mode and acknowledge only newline-terminated, successfully uploaded batches.
For baseline, airports, and the watch document, rescan complete content and rely on
content IDs or natural-key upserts. Keep batch size from validated configuration.

- [ ] **Step 6: Add the repository command**

Expose:

```text
npm run fares:supabase -- --dry-run --report $env:TEMP/airfare-source.json
npm run fares:supabase -- --apply --full --report $env:TEMP/airfare-full.json
npm run fares:supabase -- --apply --incremental --report $env:TEMP/airfare-incremental.json
npm run fares:supabase -- --verify --report $env:TEMP/airfare-verify.json
npm run fares:supabase -- --compare-reads --report $env:TEMP/airfare-read-parity.json
```

Make the modes mutually exclusive. Default to no writes: invoking the command without
`--apply` or `--verify` performs a dry run. Reports contain project ref, source root,
counts, skips, digests, durations, and status; never environment values or request
headers.

- [ ] **Step 7: Run focused and command-level tests**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_airfare_sync.py
npm run fares:supabase -- --dry-run --source .local-data --report $env:TEMP/airfare-dry-run.json
npm run lint:api
npm run typecheck:api
```

Expected: tests pass; the dry-run exits zero without requiring Supabase credentials.

- [ ] **Step 8: Commit the synchronization slice**

```powershell
git add -- package.json scripts/api.mjs scripts/fares-supabase.py services/api/app/services/airfare_sync.py services/api/tests/fares/test_airfare_sync.py
git commit -m "feat(airfare): add resumable Supabase synchronization"
```

### Task 4: Create the Deep Airfare Data Module

**Files:**

- Create: `services/api/app/services/airfare_data.py`
- Create: `services/api/tests/fares/test_airfare_data.py`

**Interfaces:**

- Consumes: existing `FareHistory`, existing `FareCalendar`, an optional `SupabaseAirfare`, and `AirfareSync`.
- Produces: `AirfareData.history(query) -> HistoryRead`, `calendar(origin, destination) -> CalendarRead`, `airports(codes) -> dict[str, Airport]`, `iter_snapshots(origin, destination) -> Iterator[FareSnapshot]`, and `sync_incremental() -> SyncReport`.

The module's external interface uses these exact domain shapes:

```python
@dataclass(frozen=True, slots=True)
class WatchHealth:
    last_checked_at: str | None
    checks: int
    changes: int
    errors: int

@dataclass(frozen=True, slots=True)
class PairReferenceSummary:
    value: float
    dates: int

@dataclass(frozen=True, slots=True)
class HistoryQuery:
    origin: str
    destination: str
    departure: str | None = None
    snapshot_months: tuple[str, ...] = ()
    since: str | None = None
    until: str | None = None

@dataclass(frozen=True, slots=True)
class HistoryRead:
    origin: str
    destination: str
    snapshots: tuple[FareSnapshot, ...]
    baseline: tuple[BaselinePoint, ...]
    health: WatchHealth
    airports: tuple[Airport, ...]
    pair_reference: PairReferenceSummary | None

@dataclass(frozen=True, slots=True)
class CalendarRead:
    origin: str
    destination: str
    horizon: Horizon | None
    health: WatchHealth
```

- [ ] **Step 1: Write failing interface tests with two adapters**

Create the same literal dataset in a temporary local archive and a mocked Supabase RPC
response. Assert the returned `HistoryRead`, `CalendarRead`, and airports are equal.
Assert local mode makes zero remote calls. Assert Supabase mode calls the RPC, maps
camelCase documents to domain models, and falls back to local on
`AirfareRemoteUnavailable` while emitting one warning containing route/store names.

- [ ] **Step 2: Add negative behavior tests**

Assert malformed successful RPC data raises `AirfareRemoteRejected` and does not fall
back as if it were a timeout; an all-unreadable local archive remains an error; a remote
empty result is a genuine empty result; and sync failure returns a failed `SyncReport`
without changing local files.

- [ ] **Step 3: Run the focused tests and confirm the interface is absent**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_airfare_data.py
```

Expected: import failure for `app.services.airfare_data`.

- [ ] **Step 4: Implement the module and production singleton**

Define frozen query/result dataclasses. Inject local and remote adapters into
`AirfareData`; construct `AIRFARE_DATA` once from validated configuration. Keep remote
transport and SQL names private. Preserve oldest-first snapshots/baselines/checks and
the exact existing calendar-horizon semantics in both adapters.

- [ ] **Step 5: Run module and existing store tests**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_airfare_data.py services/api/tests/fares/test_fare_history_store.py services/api/tests/fares/test_calendar_store.py
npm run lint:api
npm run typecheck:api
```

Expected: all commands pass.

- [ ] **Step 6: Commit the data-module slice**

```powershell
git add -- services/api/app/services/airfare_data.py services/api/tests/fares/test_airfare_data.py
git commit -m "feat(airfare): centralize archive reads and fallback"
```

### Task 5: Route Reads Through AirfareData Without Changing the Wire Contract

**Files:**

- Modify: `services/api/app/routers/fares.py`
- Modify: `services/api/tests/fares/test_fares_endpoint.py`
- Modify: `services/api/tests/test_fares_watch_transfer.py`

**Interfaces:**

- Consumes: Task 4's `AIRFARE_DATA.history`, `calendar`, and `airports` methods.
- Produces: the existing history, calendar, airport, watch-export, and watch-import HTTP contracts backed by either store.

- [ ] **Step 1: Write failing router-seam tests**

Monkeypatch `AIRFARE_DATA`, not `HISTORY`/`CALENDAR`, and assert each read endpoint asks
the deep module once. Add a transfer-export fixture larger than one mocked remote page
and assert no observation is omitted. Add an import test proving local append occurs
before incremental sync and a failed sync leaves the imported observations readable.

- [ ] **Step 2: Run the endpoint and transfer tests against the old router**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fares_endpoint.py services/api/tests/test_fares_watch_transfer.py
```

Expected: the new seam assertions fail because the router still calls `HISTORY` and
`CALENDAR` directly.

- [ ] **Step 3: Replace direct read knowledge with AirfareData calls**

Make `/history`, `/calendar`, and `/airports` map `AirfareData` results to the unchanged
Pydantic response models. Make watch export iterate through the module rather than open
`HISTORY.directory` in the router. Keep imports local-first, then request a non-fatal
incremental sync.

- [ ] **Step 4: Run the focused regression suite**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fares_endpoint.py services/api/tests/test_fares_watch_transfer.py services/api/tests/fares/test_fare_history_cache_integration.py
```

Expected: all tests pass in default local mode.

- [ ] **Step 5: Commit the router cut seam**

```powershell
git add -- services/api/app/routers/fares.py services/api/tests/fares/test_fares_endpoint.py services/api/tests/test_fares_watch_transfer.py
git commit -m "refactor(airfare): read archives through AirfareData"
```

### Task 6: Synchronize Completed Collections Without Endangering Them

**Files:**

- Modify: `services/api/app/services/collection_job.py`
- Modify: `services/api/app/services/calendar_job.py`
- Modify: `services/api/tests/fares/test_fares_endpoint.py`
- Modify: `services/api/tests/test_fares_calendar_collect.py`

**Interfaces:**

- Consumes: `AIRFARE_DATA.sync_incremental() -> SyncReport` after local pass recording is complete.
- Produces: near-real-time cloud replication whose failure never changes a successful local collection outcome.

- [ ] **Step 1: Write failing board and calendar integration tests**

For each runner, inject a sync spy and assert one sync follows the final local writes.
Inject a failed report and assert the pass still ends with its original `exit`, local
snapshot/curve and heartbeat remain readable, and the cursor is unchanged. Assert an
already-running or refused pass does not create a competing sync.

- [ ] **Step 2: Run the focused tests against the unsynchronized runners**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fares_endpoint.py services/api/tests/test_fares_calendar_collect.py
```

Expected: sync-spy call assertions fail.

- [ ] **Step 3: Trigger one bounded incremental sync after each completed pass**

Invoke the deep module through `await asyncio.to_thread(...)` after pass bookkeeping,
outside the upstream pacing loop. Guard
it with `AIRFARE_SYNC_ENABLED`; catch the typed sync failure once, log dataset counts,
and leave pass results unchanged. Reuse the synchronizer's process lock so simultaneous
board and calendar completions cannot race cursor writes.

- [ ] **Step 4: Run collection, pacing, schedule, spend, and pass tests**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fares_endpoint.py services/api/tests/test_fares_calendar_collect.py services/api/tests/test_fare_collector_pacing.py services/api/tests/fares/test_schedule_cadence.py services/api/tests/test_fares_spend.py services/api/tests/test_fares_passes.py
```

Expected: all tests pass and no test performs network I/O.

- [ ] **Step 5: Commit the live-sync slice**

```powershell
git add -- services/api/app/services/collection_job.py services/api/app/services/calendar_job.py services/api/tests/fares/test_fares_endpoint.py services/api/tests/test_fares_calendar_collect.py
git commit -m "feat(airfare): replicate completed collection passes"
```

### Task 7: Bound History Payloads and Return the Pair Reference

**Files:**

- Modify: `services/api/app/routers/fares.py`
- Modify: `services/api/tests/fares/test_fares_endpoint.py`
- Modify: `apps/web/src/shared/api/fares.ts`
- Modify: `apps/web/src/features/airfare/hooks/useFareHistory.ts`
- Modify: `apps/web/src/features/airfare/hooks/useFareHistory.test.tsx`
- Modify: `apps/web/src/features/airfare/AirfarePage.tsx`
- Modify: `apps/web/src/features/airfare/lib/pairReference.ts`
- Modify: `apps/web/src/features/airfare/lib/pairReference.test.ts`

**Interfaces:**

- Consumes: `HistoryQuery.snapshot_months: tuple[str, ...]` and `HistoryRead.pair_reference: PairReferenceSummary | None` from Task 4.
- Produces: repeated `snapshotMonth=YYYY-MM`, bounded snapshot arrays, and `pairReference: {value: number, dates: number} | null` in `FareHistoryResponse`.

- [ ] **Step 1: Write failing backend contract tests**

Seed March, April, and an unwatched May. Request March with
`snapshotMonth=2027-03&snapshotMonth=2027-04`. Assert snapshots include March and April
only, baseline/health include March only, and pair reference includes all three months.
Assert duplicate months are deduplicated, invalid values return 422, more than twelve
unique months returns 422, and omitting `snapshotMonth` returns the legacy whole pair.

- [ ] **Step 2: Write failing frontend request and summary tests**

Assert `fetchFareHistory` emits one query value per watched month and the TanStack key
changes when the watch's month set changes. Replace the old whole-snapshot reference
fixture with:

```typescript
expect(pairReference({ value: 147.69, dates: 31 }, '2026-09-15')).toEqual({
  value: 147.69,
  dates: 31,
  asOf: '2026-09-15',
});
expect(pairReference(null, '2026-09-15')).toBeNull();
```

- [ ] **Step 3: Run focused backend and frontend tests and observe contract failures**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fares_endpoint.py
npm run test -w web -- src/features/airfare/hooks/useFareHistory.test.tsx src/features/airfare/lib/pairReference.test.ts
```

Expected: backend rejects/ignores the new parameters and frontend still computes from
raw whole-pair snapshots.

- [ ] **Step 4: Implement the backend request and response models**

Add `snapshotMonth: list[str] | None` with `YYYY-MM` validation and a twelve-unique-month
limit. Add:

```python
class PairReferenceModel(BaseModel):
    value: float
    dates: int = Field(..., ge=1)

class HistoryResponse(BaseModel):
    origin: str
    destination: str
    snapshots: list[SnapshotModel]
    baseline: list[PricePointModel]
    health: WatchHealthModel
    airports: list[AirportModel]
    pairReference: PairReferenceModel | None
```

Pass the normalized month tuple into `HistoryQuery`. Preserve omitted-parameter legacy
behavior.

- [ ] **Step 5: Implement the frontend request and consumption**

Add `snapshotMonths?: readonly string[]` to `fetchFareHistory`; append each value as
`snapshotMonth`. Add the summary type to `FareHistoryResponse`. Pass `route.months` from
`useFareHistory`, include a stable joined month identity in the query key, and compute
the dated display model from `history.data.pairReference` plus `todayIso()`.

- [ ] **Step 6: Run focused and complete web tests**

```powershell
& 'services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fares_endpoint.py
npm run test -w web -- src/features/airfare/hooks/useFareHistory.test.tsx src/features/airfare/lib/pairReference.test.ts src/features/airfare/ui/AnalysisPanel.test.tsx src/features/airfare/ui/DepartureChart.test.tsx
npm run test -w web
npm run typecheck -w web
```

Expected: all commands pass.

- [ ] **Step 7: Commit the bounded-read slice**

```powershell
git add -- services/api/app/routers/fares.py services/api/tests/fares/test_fares_endpoint.py apps/web/src/shared/api/fares.ts apps/web/src/features/airfare/hooks/useFareHistory.ts apps/web/src/features/airfare/hooks/useFareHistory.test.tsx apps/web/src/features/airfare/AirfarePage.tsx apps/web/src/features/airfare/lib/pairReference.ts apps/web/src/features/airfare/lib/pairReference.test.ts
git commit -m "perf(airfare): bound history reads to watched months"
```

### Task 8: Record the Architecture Decision and Operational Runbook

**Files:**

- Create: `docs/ADRs/0003-airfare-supabase-read-store.md`
- Modify: `docs/ADRs/0002-airfare-price-history-store.md`
- Modify: `docs/deploy-plan.md`

**Interfaces:**

- Consumes: the accepted design, configuration names, exact commands, failure modes, and rollback from Tasks 1–7.
- Produces: one authoritative decision and one operator path that do not imply the collector moved to Supabase.

- [ ] **Step 1: Write ADR 0003**

Record status Accepted, date 2026-09-15, the measured inventory, the deep-module seam,
content-addressed identity, local-journal role, Postgres read role, security grants,
bounded response contract, and rollback flag. State explicitly that the watch document
is only replicated and that local deletion is not authorized by this decision.

- [ ] **Step 2: Link historical documents without rewriting their decisions**

Append an addendum to ADR 0002 pointing to ADR 0003 for cloud storage. Update the deploy
plan's shape to say market collection stays home while Airfare's indexed read copy is
in Supabase and remains reachable only through the passkey-gated PC API.

- [ ] **Step 3: Run Markdown formatting and inspect the diff**

```powershell
npm run format -- docs/ADRs/0002-airfare-price-history-store.md docs/ADRs/0003-airfare-supabase-read-store.md docs/deploy-plan.md docs/superpowers/specs/2026-09-15-airfare-supabase-migration-design.md docs/superpowers/plans/2026-09-15-airfare-supabase-migration.md
git diff --check
```

Expected: formatting succeeds and `git diff --check` prints nothing.

- [ ] **Step 4: Commit documentation**

```powershell
git add -- docs/ADRs/0002-airfare-price-history-store.md docs/ADRs/0003-airfare-supabase-read-store.md docs/deploy-plan.md docs/superpowers/specs/2026-09-15-airfare-supabase-migration-design.md docs/superpowers/plans/2026-09-15-airfare-supabase-migration.md
git commit -m "docs(airfare): record Supabase archive decision"
```

### Task 9: Apply the Schema and Run the Non-Destructive Backfill

**Files:**

- Create: `docs/airfare-supabase-backfill-report.json`
- Local ignored file: `.env` — add the secret interactively; never stage it.

**Interfaces:**

- Consumes: project `abndifkxpfppmllgxfnu`, a database password supplied interactively to the CLI, and a project-specific `sb_secret_*` key stored in `.env`.
- Produces: applied remote schema, full idempotent dataset, initialized sync cursors, and a committed non-secret verification report.

- [ ] **Step 1: Verify the exact remote target before any remote mutation**

```powershell
supabase projects list
```

Expected: `edicius-hq`, ref `abndifkxpfppmllgxfnu`, region `sa-east-1`, status
`ACTIVE_HEALTHY`. Stop if any of those values differs.

- [ ] **Step 2: Link with an interactively supplied database password**

Reset the database password in the project dashboard if its creation-time value is not
known, then run:

```powershell
supabase link --project-ref abndifkxpfppmllgxfnu
supabase migration list
```

Do not put the database password on the command line. Expected: the CLI prompts for it
and the project becomes linked.

- [ ] **Step 3: Preview and apply only the committed migration**

```powershell
supabase db push --dry-run
supabase db push
supabase migration list
```

Expected: dry-run lists `20260915000000_airfare_archive.sql`; after push, local and
remote migration lists agree. Do not use `db reset --linked`.

- [ ] **Step 4: Store a dedicated backend secret outside source control**

Create a named secret key for the PC backend in Supabase Settings > API Keys and add it
to the ignored `.env` as `SUPABASE_SECRET_KEY`. Add the exact project URL as
`SUPABASE_URL`. Confirm only the variable names, never values:

```powershell
git status --short --ignored .env
```

Expected: `.env` is ignored and absent from staged/untracked output.

- [ ] **Step 5: Capture the stable source manifest without writes**

```powershell
npm run fares:supabase -- --dry-run --source .local-data --report $env:TEMP/airfare-supabase-source.json
```

Expected: valid counts match the current logical inventory or its documented growth;
skipped records are itemized by relative file and line. Investigate any new all-invalid
file before applying.

- [ ] **Step 6: Run the full backfill and verify it**

```powershell
npm run fares:supabase -- --apply --full --source .local-data --report ../../docs/airfare-supabase-backfill-report.json
npm run fares:supabase -- --verify --source .local-data --report ../../docs/airfare-supabase-backfill-report.json
```

Expected: every dataset/route count and ordered-record-ID digest matches. The command
must exit nonzero on any mismatch.

- [ ] **Step 7: Prove idempotency with a second full pass**

```powershell
npm run fares:supabase -- --apply --full --source .local-data --report $env:TEMP/airfare-second-pass.json
npm run fares:supabase -- --verify --source .local-data --report ../../docs/airfare-supabase-backfill-report.json
```

Expected: the second report records zero newly inserted logical records and final
digests still match.

- [ ] **Step 8: Run one incremental catch-up and commit only the safe report**

```powershell
npm run fares:supabase -- --apply --incremental --source .local-data --report $env:TEMP/airfare-catch-up.json
npm run fares:supabase -- --verify --source .local-data --report ../../docs/airfare-supabase-backfill-report.json
git add -- docs/airfare-supabase-backfill-report.json
git diff --cached
git commit -m "docs(airfare): record verified Supabase backfill"
```

Expected: the committed JSON contains no key, URL query credentials, fare payloads, or
local absolute user path.

### Task 10: Canary Supabase Reads, Measure, and Cut Over

**Files:**

- Create: `docs/airfare-supabase-results.md`
- Modify: ignored `.env` only for operational flags.

**Interfaces:**

- Consumes: verified destination manifest, `AIRFARE_SYNC_ENABLED`, `AIRFARE_DATA_BACKEND`, existing measurement scripts, and the AQP-LIM canary.
- Produces: evidence-backed cutover with a one-flag rollback and no local deletion.

- [ ] **Step 1: Enable replication while keeping local reads**

Set in ignored `.env`:

```dotenv
AIRFARE_SYNC_ENABLED=true
AIRFARE_DATA_BACKEND=local
```

Restart FastAPI, run one normal due collection, then execute
`npm run fares:supabase -- --verify --source .local-data`.
Expected: the pass result is unchanged and destination catches up.

- [ ] **Step 2: Compare local and Supabase answers on every watched route**

Run `npm run fares:supabase -- --compare-reads --source .local-data --report
$env:TEMP/airfare-read-parity.json` to fetch stable local and remote history/calendar
answers for all seven watched pairs. The command canonicalizes timestamps/numbers and asserts equal
snapshots for watched months, baselines, health, airports, horizon points, and pair
reference. Save only aggregate equality/digest evidence.

- [ ] **Step 3: Measure the AQP-LIM canary before cutover**

```powershell
& 'services/api/.venv/Scripts/python.exe' scripts/measure_airfare.py --data-dir services/api/.local-data --pair AQP-LIM --samples 15 --output $env:TEMP/airfare-local-canary.json
```

Record server construction time, gzip/plain bytes, snapshots, baseline points, and
semantic digest. Label it local backend construction, not WAN latency.

- [ ] **Step 4: Switch only the read backend and repeat the canary**

Set `AIRFARE_DATA_BACKEND=supabase`, restart FastAPI, and rerun the same semantic and
payload measurement through the authenticated endpoint. The result must preserve the
semantic digest for watched months and pair reference while documenting the intentional
reduction from discarded months.

- [ ] **Step 5: Exercise failure and rollback before accepting cutover**

Temporarily set an unreachable Supabase URL in the process environment, request history
and calendar, and verify structured logs plus correct local fallback. Restore the URL.
Then set `AIRFARE_DATA_BACKEND=local`, restart, and verify the local endpoint; finally
set it back to `supabase` and restart. No database or archive mutation belongs in this
exercise.

- [ ] **Step 6: Run every repository gate**

```powershell
npm run format:check
npm run lint
npm run typecheck
npm run test
npm run build
npm run lint:api
npm run typecheck:api
npm run test:api
supabase test db
```

Expected: every command exits zero.

- [ ] **Step 7: Write and commit the final evidence**

In `docs/airfare-supabase-results.md`, record project ref/region, migration ID, source
and destination counts/digests, idempotency result, local/cloud canary measurements,
payload reduction, failure drill, exact active flags, and rollback command. Do not
include secrets, request headers, raw fares, or database passwords.

```powershell
git add -- docs/airfare-supabase-results.md
git commit -m "docs(airfare): record Supabase cutover evidence"
```

---

## Completion conditions

The migration is complete only when:

- remote schema tests and all repository gates pass;
- full and second-pass backfills prove matching counts/digests and idempotency;
- incremental sync survives a forced remote failure without data loss;
- all watched routes have local/cloud semantic parity;
- the browser requests only watched months and gets the legacy-equivalent pair reference;
- Supabase reads are active, local fallback has been exercised, and rollback has been rehearsed;
- no local archive, backup, collector state, spend ledger, pass ledger, or static catalog has been removed.
