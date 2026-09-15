# Airfare Supabase Migration Design

**Status:** Approved for planning on 2026-09-15.

## Outcome

Move Airfare's durable, queryable history into the Supabase project `edicius-hq`
(`abndifkxpfppmllgxfnu`) without moving collection away from the owner's PC and
without deleting the existing local archive. Replace whole-pair filesystem scans with
indexed route/month reads and a database-computed pair reference while preserving the
page's visible semantics and its existing passkey gate.

This is the Airfare migration only. Finance, Greenlight, Investing, Sentiment, shared
authentication, and the other KV documents are independent projects.

## Current inventory

Measured on 2026-09-15 while the collector was active. Counts and sizes can increase
after this measurement.

| Dataset                                    |                    Logical volume | Current location                                | Destination in this design                                                       |
| ------------------------------------------ | --------------------------------: | ----------------------------------------------- | -------------------------------------------------------------------------------- |
| Fare snapshots and discovered-airport file |       41.15 MiB; 13,722 snapshots | `.local-data/fares/*.jsonl`, `airports.json`    | Supabase Postgres                                                                |
| Provider baseline points                   |           6.98 MiB; 59,785 points | `.local-data/fares/baseline/`                   | Supabase Postgres                                                                |
| Calendar curves                            |            1.13 MiB; 164 captures | `.local-data/fares/calendar/*.jsonl`            | Supabase Postgres                                                                |
| Board and calendar checks                  | 1.95 MiB; more than 16,800 checks | `.local-data/fares/checks/`, `calendar/checks/` | Supabase Postgres; local scheduling state remains                                |
| Airfare watch document                     |                1.16 KiB; 7 routes | `.local-data/kv/airfare-routes.json`            | Supabase replica in this project; local write authority until shared KV migrates |
| Board and calendar fingerprints            |                            34 KiB | `.local-data/fares/state/`, `calendar/state/`   | Owner PC only                                                                    |
| Request-spend ledger                       |           1.94 MiB; 16,791 events | `.local-data/fares/spend/`                      | Owner PC only                                                                    |
| Collection-pass ledger                     |            0.45 MiB; 2,166 passes | `.local-data/fares/passes/`                     | Owner PC only                                                                    |
| Backup artifacts                           |                          8.19 MiB | `.bak`, `.pre-month-*`                          | Owner PC; eligible for a separately approved private-Storage archival operation  |
| Static airport/subdivision catalogs        |                          6.56 MiB | `services/api/app/data/`                        | Versioned application data; CDN extraction is a separate optimization            |

The initial Postgres backfill is approximately 51.2 MiB of logical source data. Actual
database storage will be larger because Postgres stores row metadata and indexes.

`AQP-LIM.jsonl` is the first performance canary: at 24.32 MiB it holds about 59% of
the active snapshot archive.

## Non-negotiable constraints

- Google Flights requests continue to originate from `services/api` on the owner's
  residential connection. Supabase never fetches Google Flights.
- The Vercel browser continues to call the passkey-gated FastAPI application. A
  Supabase secret key never reaches browser code, a `VITE_*` variable, source control,
  logs, URLs, or generated reports.
- The new Supabase secret key is sent to the Data API only in the `apikey` header. It
  is not used as an `Authorization: Bearer` value.
- All Airfare tables have RLS enabled and grants revoked from `anon` and
  `authenticated`; only `service_role` receives the privileges used in this phase.
- Local JSONL and JSON files are read-only inputs to the backfill and remain intact
  after cutover. Removing or pruning them requires a separate, explicit decision.
- Local mode remains the default when Supabase configuration is absent. Tests never
  contact the live project.
- An unavailable Supabase read falls back to the local archive and logs the source
  change. It never returns a successful empty history for an unavailable store.
- Existing snapshot, baseline, health, calendar-horizon, airport, transfer, ordering,
  corrupt-line, and null-price semantics remain true.
- Hardware acceleration is not used.

## Deployment shape

```text
Vercel SPA
    |
    | existing passkey session
    v
FastAPI on owner PC ---------------------> Supabase Data API
    |                                      indexed history reads
    |                                      canonical cloud replica
    v
Google Flights
residential egress
    |
    v
local JSONL/JSON ---- incremental sync --> Supabase Data API
durable journal +      idempotent batches
collector state
```

The clean seam is a deep `AirfareData` module. Its interface returns Airfare domain
answers: history, calendar, airports, synchronization reports, and replica manifests.
The router and collector do not learn PostgREST URLs, headers, table names, batching,
record hashes, retry rules, or fallback rules. `SupabaseAirfare` is the external adapter
inside that module; tests use an `httpx.MockTransport` adapter at the same seam.

The existing `FareHistory` and `FareCalendar` modules remain the local durable journal
and operational scheduler input. Replacing them during the first migration would mix a
storage move with proven collector semantics and would remove the safest rollback.

## Postgres model

All original wire documents are kept in `payload jsonb`; typed columns hold the keys
needed for filtering, ordering, health summaries, and the pair reference. This retains
exact domain content without normalizing every historical itinerary into a new mutable
model.

### `fare_snapshots`

- `record_id text primary key`: SHA-256 of record kind plus canonical source JSON.
- `origin text`, `destination text`: normalized uppercase IATA codes.
- `flight_date date`, `captured_at timestamptz`, `captured_at_text text`.
- `source text`, `currency text`.
- `cheapest_price numeric`: minimum non-null offer price in this snapshot.
- `payload jsonb`: complete snapshot in the current camelCase wire shape.
- Indexes on `(origin, destination, flight_date, captured_at)` and
  `(origin, destination, captured_at)`.

### `fare_baseline_points`

- `record_id text primary key`.
- Route, `flight_date`, observation `price_date`, `price`, `currency`, and `source`.
- `payload jsonb` for source-shape fidelity.
- Index on `(origin, destination, flight_date, price_date)`.

### `fare_calendar_captures`

- `record_id text primary key`.
- Route, `captured_at`, `from_date`, `to_date`, `source`, and `currency`.
- `payload jsonb`, including explicit null prices and absent-date gaps.
- Index on `(origin, destination, captured_at desc)`.

### `fare_checks`

- `record_id text primary key`.
- `kind text check (kind in ('board', 'calendar'))`.
- Route, nullable `flight_date`, `checked_at`, `outcome`, offer count, cheapest price,
  and nullable provider error code.
- `payload jsonb` for fidelity.
- Indexes on `(kind, origin, destination, flight_date, checked_at)` and
  `(kind, origin, destination, checked_at)`.

### `fare_airports`

- IATA `code text primary key`, names, country, coordinates, and `payload jsonb`.
- Provider-discovered facts win over the bundled static coordinate fallback.

### `airfare_documents`

- `key text primary key check (key = 'airfare-routes')`.
- `value jsonb`, `source_updated_at`, and `replicated_at`.
- This phase replicates the watch document for recovery and the eventual shared-KV
  migration. The current local atomic document remains write-authoritative because
  changing one 1.16 KiB document cannot materially improve Airfare latency and the
  generic KV transaction rules are shared by every page.

### `airfare_import_runs`

- Run identifier, mode, start/end timestamps, status, source-manifest JSON, destination
  manifest JSON, and error text.
- Contains counts and hashes only, never raw fares or credentials.

## Identity and idempotency

Every imported append-only record receives:

```text
record_id = sha256(kind + "\n" + origin + "-" + destination + "\n" + canonical_json(source_row))
canonical_json = UTF-8 JSON, sorted keys, compact separators, no ASCII escaping
```

Route context is part of the identity because baseline and check rows do not carry their
route inside the JSON. The content hash makes a full rerun safe and retains two
observations that share a timestamp but differ in content. Byte-identical duplicate
lines for the same route are one logical record, matching the existing watch-import
deduplication rule. Manifests report both physical valid lines and unique logical
records so a collapsed duplicate is visible. Table upserts use `record_id`; a second
full backfill must not change the destination manifest. The proof is matching
normalized destination manifests from successful verification immediately before and
after that replay; attempted-upsert counts are not an insertion metric.

Airports and the watch document use their natural keys and deterministic upserts.

## Sync and backfill

The local archive is the durable journal during and after this migration. A sync module
parses it with the same tolerance as the existing readers, batches records, writes them
idempotently through the Data API, and advances local cursors only after a complete
batch succeeds.

Append-only JSONL cursors contain relative path, byte offset, size, and modification
stamp under `.local-data/fares/sync/cursors.json`. A missing, truncated, or replaced
source resets that path to byte zero; content hashes make replay safe. A partial final
line is not uploaded and its bytes are not acknowledged. Rewritten baseline, airport,
and watch documents are scanned as whole small datasets and upserted.

The command has four explicit modes:

- `--dry-run`: parse and emit the source manifest without network writes.
- `--apply`: upload full or incremental batches and record an import run.
- `--verify`: compare count and ordered-record-ID digests per dataset and route.
- `--compare-reads`: compare canonical local and remote history/calendar answers for
  every watched route without writing either store.

Each invocation emits one aggregate-only report in its existing mode-specific schema;
there is no synthetic single-file evidence envelope. The reviewed evidence set is the
named collection of dry-run, apply, verification, parity, and (when an accepted tool
exists) canary reports in [the deployment runbook](../../deploy-plan.md#backfill-reconciliation-and-idempotency-gate).
The before/after second-full verification reports are the retained idempotency proof.

The initial run is full and does not depend on cursor state. Its successful completion
sets cursors to the corresponding source ends. Collection integration then runs an
incremental sync after a completed board or calendar pass. Sync failure does not erase
local data or rewrite a successful collection result; it is logged and retried on the
next pass or explicit command.

## Read contract and latency change

Merely moving the current 24.32 MiB canary document would retain its dominant cost.
The history read therefore changes in one controlled way:

- `GET /api/fares/history` accepts repeated `snapshotMonth=YYYY-MM` values.
- When they are supplied, `snapshots` contains their union rather than every month ever
  stored for the pair. An omitted parameter preserves the whole-pair behavior for old
  callers and transfer tooling.
- `baseline` and `health` retain the existing `departure` prefix behavior.
- The response adds `pairReference: { value, dates } | null`, computed across the whole
  pair as the median of each departure date's cheapest-ever observed fare.
- The web hook supplies every month currently watched for the selected pair, so chart A
  and chart B retain their data. The page uses the returned pair reference rather than
  downloading discarded months to compute it.

The database function `read_airfare_history` returns one JSON object so PostgREST's row
limit cannot silently truncate snapshots, baseline points, or checks. It orders arrays
explicitly. `read_airfare_calendar` reproduces the current horizon rule: newest curve's
near boundary, furthest answered far boundary, newest observation per departure, and
no resurrection of departed dates or overwriting explicit null with an older fare.

`AirfareData` maps these documents back to the current Pydantic/domain models before
the router returns them. This keeps storage representation out of browser code.

## Failure and rollback behavior

- Missing Supabase configuration in local mode: operate exactly as before.
- Missing configuration with sync or Supabase reads enabled: fail startup with the
  missing variable names, without printing values.
- Supabase timeout, 429, 5xx, or network failure during sync: retain cursors, log one
  bounded error, retry on the next invocation.
- Permanent 4xx/schema mismatch: mark the sync run failed and stop that batch; do not
  loop aggressively.
- Supabase read failure: read the local archive and record a structured warning naming
  the requested route and the two stores, not credentials.
- Corrupt local line: count and skip it exactly as the existing archive reader does;
  verification reports the skip.
- Rollback: set `AIRFARE_DATA_BACKEND=local` and restart FastAPI. Collection and its
  local journal never changed location, so rollback needs no database mutation.

## Security

The browser receives no Supabase key in this phase. The PC backend uses
`SUPABASE_URL` and `SUPABASE_SECRET_KEY`; the key is kept only in the ignored `.env` or
the process environment. Supabase currently recommends a server-side secret key and
the `apikey` header for controlled backend workloads. The schema combines RLS with
revoked public grants, and stored functions revoke execution from `public`, `anon`, and
`authenticated` before granting it to `service_role`.

References:

- https://supabase.com/docs/guides/getting-started/api-keys
- https://supabase.com/docs/guides/database/postgres/row-level-security
- https://supabase.com/docs/guides/local-development/cli-workflows

## Acceptance criteria

1. Successful verification immediately before and after a second full backfill has
   identical normalized destination manifests; attempted-upsert counts are not used as
   insertion evidence.
2. Source and destination counts plus ordered-record-ID digests match for snapshots,
   baseline points, calendar captures, and both check kinds, grouped by route.
3. Local and Supabase readers return semantically equal history/calendar/airport
   answers from the same stable fixture.
4. Every existing Airfare backend and frontend test remains green after contract
   updates.
5. The browser requests only watched months, and the pair reference equals the legacy
   whole-archive calculation.
6. A Supabase outage during collection loses no observation and leaves the cursor at
   the last acknowledged batch.
7. `AIRFARE_DATA_BACKEND=local` restores the pre-cutover read path with one restart.
8. An accepted configured-backend canary records its explicit timing boundary,
   compressed/uncompressed bytes, snapshot count, and semantic response digest before
   and after cutover.

## Out of scope

- Direct browser-to-Supabase reads. They require a cloud-verifiable user identity or a
  new authenticated proxy; the existing passkey session is owned by the PC API.
- Moving the Google Flights collector, scheduler, spend ledger, pass ledger,
  fingerprints, locks, or SSE process state off the PC.
- Deleting, pruning, or rewriting the local archive.
- Uploading backups to Storage. It is a separate destructive-lifecycle decision even
  if the upload itself is non-destructive.
- Moving the static airport/subdivision catalogs to a CDN. That is an independent
  frontend-delivery optimization with its own cache and bundle measurements.
- Migrating non-Airfare KV documents or any other product page.
