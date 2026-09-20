# Lossless Airfare History Pagination Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Read complete multi-month Airfare history through bounded, revision-checked pages without changing the caller-facing response or losing observations.

**Architecture:** Add transactional revision tracking and four additive PostgreSQL RPCs. Focused Python and TypeScript readers assemble and validate the same legacy document before returning anything to existing consumers. Ship database support first; gate consumer rollout on security, parity, concurrency and actual hosted latency.

**Tech Stack:** PostgreSQL 17/Supabase/PostgREST/pgTAP, Python 3.12+ with existing httpx/pytest, TypeScript/React Query/Supabase JS/Vitest, PowerShell orchestration on Windows and existing Pi operations tooling.

**Spec:** [Approved design](../specs/2026-09-19-airfare-history-pagination-design.md). Read the whole spec, `CONTEXT.md`, `docs/ADRs/0004-pi-collectors-supabase-data-plane.md` and `docs/airfare-sync-contract.md` before implementation. ADR 0004 supersedes the older watch-authority wording.

## Global Constraints

- “No merge, Task 12, deletion, downsampling, timeout increase, new credentials, collector activation, or observation-window completion is authorized by this spec.”
- “Default page size is 100 rows; the server accepts 1–250.”
- “Bound the complete serialized JSON page to 1 MiB” and “Apply the same 1 MiB bound to metadata responses”.
- “Allow two restarts (three attempts total), with cancelable backoffs of 100ms and 250ms.”
- “Keep current per-request/database timeouts. Add a 60-second whole-operation budget, including restarts and backoff, for each logical route/filter read.”
- “Disable automatic outer retries for this history query” and “Preserve scheduled refetch/invalidation behavior”.
- “Use a new additive migration after `20260919000000`; preserve the deployed optimization and all legacy RPCs.”
- “Install revision metadata/triggers and new readers atomically.”
- “Enable RLS on the revision table. Grant service_role SELECT only and grant browser roles no direct access.”
- “For three consecutive runs on the retained current archive, each hosted SQL page and metadata request must remain below 5 seconds”, with exact parity and each complete logical read under 60 seconds.
- “Retain all original archives, candidates and backups.” The 24-hour/seven-day observation periods have not started.

## Review Focus

1. A replay inserts behind the cursor or changes its source position: reject the old revision even when page ordering alone looks plausible (Tasks 2 and 5).
2. Distinct tied observations have source lines above `2^53`: preserve every identity and exact integer order, including across month boundaries (Tasks 2–4).
3. Byte limits shorten a nonterminal page, or one payload cannot fit: advance without loss or explicitly reject; never spin on an empty page (Tasks 2–4).
4. A late failure, cancellation during backoff, or final-check mutation follows several good pages: publish nothing from that attempt and never multiply the retry budget (Tasks 3–5).
5. Empty month arrays, duplicate months and arbitrary valid departure prefixes differ from whole-route reads: preserve existing counts, summaries, nulls and full-pair reference semantics (Tasks 1–4).

---

## Execution boundaries and file map

Work only in `D:/Work/research/edicius-hq/.worktrees/pi-collectors-supabase`, branch `feat/pi-collectors-supabase`. The environment's default `finance-auth-jwt-fix` worktree is unrelated. Verify `git status --short`, `git branch --show-current` and `git rev-parse HEAD` before edits. Baseline product commit is `6d91738`; approved specification commit is `1a0effe`.

Preserve these untracked artifacts without staging them: `.task11-pi-bootstrap-wizard.sh`, `docs/task11-pi-collectors-handoff.md`, `docs/pi-collectors-evidence/`, and `docs/superpowers/plans/2026-09-19-airfare-rollback-reconciliation.md`. Use explicit paths in every `git add`, never `git add .`. Do not push a partially implemented protocol or run a hosted migration while implementing Tasks 1–5.

| File                                                                | Responsibility                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `supabase/migrations/20260919010000_airfare_history_pagination.sql` | Atomic revision tracking, canonical filters, metadata/page RPCs, owner wrappers and justified indexes |
| `supabase/tests/airfare_history_revision.test.sql`                  | Mutation coverage, summary parity and ACLs                                                            |
| `supabase/tests/airfare_history_pagination.test.sql`                | Cursor, byte budget, filter and full-document equivalence                                             |
| `supabase/benchmarks/airfare_history_pagination.sql`                | Local ordered-query plans and importer overhead measurements                                          |
| `scripts/test-airfare-history-pagination.ps1`                       | Isolated local database setup and fail-closed pgTAP execution                                         |
| `scripts/test-airfare-history-concurrency.ps1`                      | Two real psql sessions, synchronized mutation schedules                                               |
| `fixtures/airfare-history-pagination/v1.json`                       | Hand-authored, deterministic shared wire examples and expected legacy documents                       |
| `services/api/app/services/airfare_history_pages.py`                | Python protocol validation, assembly and cancellation-aware retry lifecycle                           |
| `services/api/app/services/airfare_supabase.py`                     | Existing transport plus sanitized conflict signal and scoped async history transport                  |
| `services/api/app/services/airfare_data.py`                         | Switch only remote history acquisition; retain domain checks and fallback                             |
| `scripts/fares-supabase.py`                                         | Strict assembled remote parity, monthly and complete watched-month queries                            |
| `services/api/tests/fares/test_airfare_history_pages.py`            | Shared fixture and logical-read tests                                                                 |
| `services/api/tests/fares/test_airfare_supabase.py`                 | Transport error classification and active-request deadlines                                           |
| `services/api/tests/fares/test_airfare_data.py`                     | Fallback and rejection behavior through real domain boundary                                          |
| `services/api/tests/fares/test_airfare_sync.py`                     | CLI comparisons and unchanged importer contracts                                                      |
| `apps/web/src/features/airfare/data/airfareHistoryPages.ts`         | Browser protocol types, validation and assembly                                                       |
| `apps/web/src/features/airfare/data/airfareHistoryPages.test.ts`    | Shared fixtures, retries, deadline and cancellation                                                   |
| `apps/web/src/features/airfare/data/supabaseAirfare.ts`             | Owner RPC adapter and signal forwarding                                                               |
| `apps/web/src/features/airfare/data/supabaseAirfare.test.ts`        | Adapter integration, unchanged calendar/search reads                                                  |
| `apps/web/src/features/airfare/hooks/useFareHistory.ts`             | Disable outer retries for history only                                                                |
| `apps/web/src/features/airfare/hooks/useFareHistory.test.tsx`       | Real QueryClient lifecycle and no partial cache publication                                           |
| `docs/airfare-history-pagination.md`                                | Protocol, validation commands, rollout and rollback operator guide                                    |

Do not add runtime dependencies. Node is already constrained to >=22; Python checks target 3.12, and the Pi uses 3.13. Keep protocol helpers internal; do not export cursor handling to chart/domain consumers. Existing `apps/web/src/shared/api/fares.ts` already forwards the signal and should not need behavior changes.

## Locked cross-task interfaces

The six base SQL arguments, in order, remain:

```sql
p_origin text, p_destination text, p_departure text,
p_snapshot_months text[], p_since text, p_until text
```

Append `p_expected_revision text default null` for both metadata RPCs. Append `p_revision text, p_dataset text, p_cursor jsonb default null, p_page_size integer default 100` for both page RPCs. All return `jsonb`. Core names are `read_airfare_history_meta` and `read_airfare_history_page`; wrapper names prepend `read_owner_` instead of `read_`. Both core functions are STABLE/SECURITY INVOKER; both wrappers STABLE/SECURITY DEFINER with the existing owner check on every call. All have `search_path = ''`.

Use these exact wire shapes; `Payload` means a JSON object preserved unchanged:

```typescript
type Dataset = 'snapshots' | 'baseline';
type Position = [string, string, string];
type HistoryCursor = {
  protocolVersion: 1;
  queryKey: string;
  revision: string;
  dataset: Dataset;
  after: Position;
};
type HistoryItem = { recordId: string; order: Position; payload: Record<string, unknown> };
type HistoryMeta = {
  protocolVersion: 1;
  queryKey: string;
  revision: string;
  origin: string;
  destination: string;
  counts: { snapshots: string; baseline: string };
  health: FareHistoryResponse['health'];
  airports: FareHistoryResponse['airports'];
  pairReference: FareHistoryResponse['pairReference'];
};
type HistoryPage = {
  protocolVersion: 1;
  queryKey: string;
  revision: string;
  dataset: Dataset;
  items: HistoryItem[];
  nextCursor: HistoryCursor | null;
};
```

Snapshot `order`/`after` is `[captured_at_text, source_line_decimal, record_id]`; baseline is `[flight_date, price_date, record_id]`. Revision and source line match `^[1-9][0-9]*$` and fit signed PostgreSQL bigint; counts match `^(0|[1-9][0-9]*)$`. Record IDs match `^[0-9a-f]{64}$`. Never accept booleans or JSON numbers for these strings. Dates use the stored canonical date spelling; captured text preserves the existing lexical ordering, not parsed timestamp ordering.

Private SQL helper `public.airfare_history_query_key(text,text,text,text[],text,text) returns text` normalizes empty optional text to null, sorts/deduplicates months, preserves null versus empty months, and includes version and exact route. Return `md5(jsonb_build_array(1, origin, destination, departure, months, since, until)::text)` after normalization/validation; this is an opaque binding key, not a security hash. Reject null/malformed month elements (strict `YYYY-MM`, valid nonzero year/month) with `22023/airfare_history_invalid_request`. Clients bind to the validated initial metadata's key and reuse identical filters; they do not independently recreate PostgreSQL JSON serialization.

Additional fixed errors: `40001/airfare_history_revision_changed`, `22023/airfare_history_item_too_large`, `22023/airfare_history_metadata_too_large`, `22023/airfare_history_invalid_cursor`. Missing singleton is `55000/airfare_history_revision_missing`. Revoke default PUBLIC execute on new internal functions. Grant service_role EXECUTE on the pure query-key helper because the invoker core readers call it; browser roles need no direct helper access. The trigger function receives no client execution grant. None of these messages contain request values or payloads.

Python public method:

```python
def read_history(
    self,
    params: Mapping[str, object],
    *,
    cancel_event: threading.Event | None = None,
) -> dict[str, Any]:
    """Return one complete legacy document or a sanitized AirfareRemoteError."""
```

The internal helper is async `assemble_history(rpc, params, *, check_cancelled, sleep) -> dict[str, Any]`, where `rpc(name: str, params: Mapping[str, object])` is awaitable, `check_cancelled() -> None` raises on cancellation, and `sleep(seconds: float)` is awaitable. It consumes only the core RPCs. Define `AirfareHistoryRevisionChanged(AirfareRemoteError)` beside existing exceptions. Internal validators raise `AirfareRemoteRejected`; exhausted churn/deadline/network raise `AirfareRemoteUnavailable`. Avoid import cycles by importing the helper locally from `read_history`.

Browser internal entry point:

```typescript
type HistoryRpc = (
  name: 'read_owner_airfare_history_meta' | 'read_owner_airfare_history_page',
  params: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;
function assembleHistory(
  rpc: HistoryRpc,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<FareHistoryResponse>;
```

The adapter converts only the exact revision code/message into internal `HistoryRevisionChanged`; all other failures remain sanitized errors. Add `signal?: AbortSignal` to its existing `HistoryOptions`. Maintain current adapter defaults: browser omitted months becomes `[]`; Python `HistoryQuery` empty tuple becomes SQL null as before. Neither adapter may silently change its established caller semantics.

## Task 1: Transactional revision and bounded metadata

**Files:** Create the migration, revision SQL test and isolated SQL runner listed above. Start the operator guide with local validation instructions.

**Interfaces:** Consumes the existing four archive tables, `edicius_owners`, `auth.uid()` and legacy six-filter RPC. Produces revision table `public.airfare_history_revision(singleton boolean primary key check(singleton), revision bigint not null check(revision > 0))`, initial row `(true,1)`, helper `airfare_history_query_key`, and both metadata RPC signatures defined above. Only this table owns the counter.

- [ ] **Step 1: Write isolated pgTAP runner and a failing metadata test.**

The runner accepts `-Database <name> -Create -Tests <string[]>`; default name is `airfare_pagination_test_` plus a GUID's lowercase hex. Reject any supplied name not matching `^airfare_pagination_test_[a-f0-9]{32}$`. Use only Docker container `supabase_db_edicius-hq`, local `postgres` role, and Docker stdin; never a linked/hosted URL. On `-Create`, clone schema only using `pg_dump --schema-only --no-owner` from local `postgres` into the newly created database, retaining grants, then apply only the new pagination migration. First verify the source schema has all repository migrations through `20260919000000`; if not, stop and prepare an isolated baseline without changing the shared database. Refuse an existing database for `-Create`. Retain the test database and print its name for reruns; never reset the shared stack or automatically drop any database.

Use `ProcessStartInfo.ArgumentList` and redirected UTF-8 stdin/stdout, not shell-composed SQL. Check every child exit code. Run each SQL test with `psql -X -At -v ON_ERROR_STOP=1`, preparing pgTAP and `search_path=public,extensions` for that connection. Reject `not ok`, missing `1..N`, a plan/assertion count mismatch or nonzero exit; SQL exit zero alone does not mean pgTAP passed. Existing tests already own BEGIN/ROLLBACK: set up the extension outside those test transactions in this disposable database only.

Implement a reusable local process primitive in the runner (return captured output; callers validate TAP separately):

```powershell
function Invoke-LocalDocker([string[]] $DockerArguments, [string] $InputText = '') {
    $start = [System.Diagnostics.ProcessStartInfo]::new('docker')
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $DockerArguments) { $start.ArgumentList.Add($argument) }
    $process = [System.Diagnostics.Process]::Start($start)
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.Write($InputText)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit(120000)) {
        $process.Kill($true)
        throw 'Local database command exceeded its harness deadline'
    }
    $text = $output.GetAwaiter().GetResult()
    $stderr = $errors.GetAwaiter().GetResult()
    if ($process.ExitCode -ne 0) { throw "Local database command failed: $stderr" }
    $process.Dispose()
    return $text
}
```

Set stdin/stdout/stderr encoding explicitly to UTF-8 without BOM before Start. The helper receives synthetic/local schema inputs only; do not reuse its raw stderr output for hosted credential-bearing commands. Use try/finally for disposal when implementing failure branches, and asynchronously write large schema input so the harness deadline also bounds stdin transfer. Assemble SQL text by concatenation; do not use PowerShell regex replacement with SQL `$$` in its replacement string.

Initial test (then extend its plan count with each assertion):

```sql
begin;
select plan(3);
select has_function('public', 'read_airfare_history_meta',
  array['text','text','text','text[]','text','text','text']);
set local role service_role;
select is(public.read_airfare_history_meta('NON','DST',null,null,null,null)
  -> 'counts', '{"snapshots":"0","baseline":"0"}'::jsonb,
  'empty route has exact string counts');
select ok(not has_table_privilege('service_role',
  'public.airfare_history_revision','UPDATE'), 'writer cannot directly alter revision');
reset role;
select * from finish();
rollback;
```

- [ ] **Step 2: Run RED.**

```powershell
./scripts/test-airfare-history-pagination.ps1 -Create -Tests @('supabase/tests/airfare_history_revision.test.sql')
```

Expected: missing metadata function. Keep the printed isolated database name for subsequent commands; use `-Database` and omit `-Create` on reruns. The runner applies the current new migration transactionally on reruns before testing; it must not replay unrelated migrations then. Make new definitions safely replaceable locally (`create or replace`, explicit trigger replacement, singleton insert `on conflict do nothing`), without resetting revision.

- [ ] **Step 3: Add counter and statement triggers.**

```sql
create or replace function public.advance_airfare_history_revision()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  update public.airfare_history_revision
     set revision = revision + 1 where singleton;
  if not found then
    raise exception using errcode = '55000', message = 'airfare_history_revision_missing';
  end if;
  return null;
end;
$$;
create trigger airfare_history_revision_change
after insert or update or delete or truncate on public.fare_snapshots
for each statement execute function public.advance_airfare_history_revision();
```

Create the same named trigger on each of `fare_baseline_points`, `fare_checks`, `fare_airports`. Enable RLS; service_role gets SELECT only, browser roles nothing; revoke trigger-function execution from PUBLIC, anon, authenticated and service_role. Its owner retains the privileges needed to update the singleton. Do not modify archive table grants or grant DELETE to replication roles.

- [ ] **Step 4: Implement canonical filters and metadata using the legacy relational expressions.**

Use PL/pgSQL STABLE with empty search path. Validate expected revision's type/range; read the singleton once and reject mismatch before building the response. Copy the legacy selected-month and inclusive lexical predicates exactly, but count rows without selecting payloads. Copy `per_departure`, `pair_reference`, health and origin-first airport expressions from `20260919000000_airfare_history_json_construction.sql`. Do not call the giant legacy RPC internally. Build decimal counts with `count(*)::text`:

```sql
if p_expected_revision is not null and p_expected_revision <> v_revision::text then
  raise exception using errcode = '40001', message = 'airfare_history_revision_changed';
end if;
-- v_body is the assembled metadata JSONB, including all summary fields.
if octet_length(convert_to(v_body::text, 'UTF8')) > 1048576 then
  raise exception using errcode = '22023', message = 'airfare_history_metadata_too_large';
end if;
return v_body;
```

The comment names a local variable the function must declare as `jsonb`; it is populated with the documented wire fields using `jsonb_build_object`. Keep every metadata SELECT inside the same STABLE function call. Add the owner wrapper using the exact existing `auth.uid()`/`edicius_owners` guard; do not accept a caller-supplied owner ID.

- [ ] **Step 5: Extend tests and run GREEN.**

Add explicit pgTAP assertions for every operation on all four tables, upsert monotonicity (not exactly +1), a rolled-back savepoint restoring both payload and revision, missing singleton failure, and no increments for calendar captures/import status/watch writes. Exercise writes with `SET LOCAL ROLE service_role`, not only postgres. Compare metadata minus protocol/count fields against the corresponding legacy fields on the precision/null/airport fixtures from `airfare_history_json.test.sql`. Test null versus empty months, duplicate months and `departure='2026'`, `departure='2026-11-0'`; snapshots do not inherit the departure scope. Oversized airport payload must reject metadata rather than omit it.

Test anon denial, authenticated non-owner denial, authorized-owner success, service-role core success, no direct authenticated table access, exact function volatility/search path and direct trigger-function denial. Use the existing `collector_data_plane.sql` owner fixture conventions. Run the entire existing SQL suite plus the new file through the runner.

- [ ] **Step 6: Commit only Task 1 files.**

```powershell
git add supabase/migrations/20260919010000_airfare_history_pagination.sql supabase/tests/airfare_history_revision.test.sql scripts/test-airfare-history-pagination.ps1 docs/airfare-history-pagination.md
git diff --cached --check
git commit -m "feat: add transactional airfare history metadata"
```

Run commands separately, checking each exit code. This is a local intermediate commit, not a deployable migration until Task 2 is complete.

## Task 2: Lossless bounded page RPCs and shared protocol fixtures

**Files:** Extend the same migration; create `supabase/tests/airfare_history_pagination.test.sql`, `supabase/benchmarks/airfare_history_pagination.sql`, and `fixtures/airfare-history-pagination/v1.json`; extend operator guide.

**Interfaces:** Consumes Task 1 revision/key/metadata. Produces both page RPCs and the exact `HistoryPage`/`HistoryCursor` wire contract. Shared fixture root has `filters`, `meta`, `snapshotPages`, `baselinePages`, `expected`; expected is a handwritten legacy document, not generated from assembled output.

- [ ] **Step 1: Write RED tests with four tied snapshots and two baseline rows.**

Use the existing JSON-equivalence fixture's full payloads and add source lines `9007199254740992` and `9007199254740993` with identical captured text across November/December. Use page size 1 and then 2. Save `read_airfare_history(...)` locally before paging as the oracle; reassemble SQL arrays by returned order and compare the complete JSONB document, including precise numeric fields. Never use JavaScript/Python floating point for the SQL precision assertion.

```sql
select throws_ok(
  $$select public.read_airfare_history_page('JSN','DST',null,null,null,null,
     '1','snapshots',null,0)$$,
  '22023', 'airfare_history_invalid_request', 'zero page size is rejected');
select throws_ok(
  $$select public.read_airfare_history_page('JSN','DST',null,null,null,null,
     '1','snapshots','{"after":[]}'::jsonb,1)$$,
  '22023', 'airfare_history_invalid_cursor', 'cursor shape is checked');
```

Validation of filter/page/cursor shape precedes revision comparison so malformed input does not become a retryable conflict. Valid stale revisions still yield only the exact conflict error. Run the isolated runner with the new test file; expect missing page functions.

- [ ] **Step 2: Implement strict cursor validation and keyset queries.**

Validate required JSON object/string/array types and exactly three tuple entries before casts. Reject missing/extra cursor fields, cross-query/revision/dataset bindings, nonpositive/out-of-range bigint values and invalid IDs. Require `after[2]` to match the last item's ID on emitted cursors. Page dataset is only `snapshots` or `baseline`.

Use an ordered key-only candidate CTE, limited to `p_page_size + 1`, then join only those candidate IDs to fetch payloads. The snapshot continuation predicate is:

```sql
(s.captured_at_text, s.source_line, s.record_id) >
  (v_after_text, v_after_line, v_after_id)
```

The first page has no continuation predicate. Baseline uses `(flight_date, price_date, record_id)` and the independent departure prefix. Retain all six filters and distinct month ranges; use no OFFSET. Do not select payloads into a full-route sort. Build each item with original JSONB payload and source_line::text. Keep route/continuation selection in the same STABLE call as revision validation.

- [ ] **Step 3: Implement the byte-bounded ordered prefix.**

Accumulate at most page-size items in an SQL `jsonb[]`. The extra candidate determines whether rows remain. For every proposed prefix, construct the actual response envelope and proposed cursor, then compute `octet_length(convert_to(response::text,'UTF8'))`. On overflow, return the previous fitting prefix with its last-item cursor; if there is no fitting item, raise `22023/airfare_history_item_too_large`. A candidate's cursor is null only when it is the final candidate and there was no lookahead. Recheck the final response size, including the cursor, before returning.

```sql
if v_bytes > 1048576 then
  if cardinality(v_items) = 0 then
    raise exception using errcode = '22023', message = 'airfare_history_item_too_large';
  end if;
  return v_previous_nonterminal_response;
end if;
```

Declare `v_items jsonb[]`, `v_bytes integer` and `v_previous_nonterminal_response jsonb`. Keep a separately measured nonterminal envelope for the previous prefix: changing null to a cursor can make an otherwise fitting terminal envelope too large. Never accept the overflowing item into the saved prefix. PostgreSQL JSONB text includes conservative spacing; hosted acceptance also measures the actual HTTP bytes.

- [ ] **Step 4: Complete page/security/filter/size tests and shared fixtures.**

Write explicit assertions for page sizes 1/100/250, reject 0/251/null, no rows, exact multiples, duplicate months, null versus empty months, inclusive bounds and arbitrary departure prefixes. Test a 700-KiB multibyte payload plus another 400-KiB payload: first response must have one item and a cursor, second one item and null; each complete response fits 1 MiB. A >1-MiB single payload rejects. A too-large later row may follow a valid earlier page, but no reader may publish that partial result.

Repeat owner/service/anon/non-owner ACL tests for the page wrapper and core. Valid owner cursors never replace the owner check. Check `provolatile`, `prosecdef`, empty search_path and no new direct table grants.

The shared JSON fixture uses revision `9007199254740993`, counts `{"snapshots":"4","baseline":"2"}`, known 64-hex record IDs, cross-month tied timestamp/source-line examples, explicit null and zero, origin-first airports and complete expected health/reference. Include only exactly representable payload numbers in this cross-language fixture; SQL separately proves larger numeric precision. Use two snapshot pages and one baseline page, with explicit nonterminal cursor objects. Unit tests mutate copies to cover malformed responses, never derive expected output with production validators.

- [ ] **Step 5: Measure plans before adding indexes, then run GREEN.**

In the isolated database, seed representative route sizes and distributions from synthetic fixtures or an authorized frozen local archive import. Benchmark first and deep pages for null months and bounded months, recording `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`. Verify the limited candidate set is formed before payload fetching. Candidate additive indexes are `(origin,destination,captured_at_text,source_line,record_id)` for snapshots and `(origin,destination,flight_date,price_date,record_id)` for baseline. Add only indexes supported by measurements; retain existing month indexes. Do not force a new collation or change comparisons to fit an index.

Record counter overhead for actual 250-row importer upserts, including concurrent writer serialization; compare equal synthetic loads in separate isolated transactions/databases with and without the new migration. Do not disable hosted triggers for a benchmark. Run all SQL tests and record page byte maxima, payload rows fetched and timing; do not claim hosted performance from local plans.

- [ ] **Step 6: Commit Task 2 files with `feat: add bounded revision-checked airfare pages`.**

Explicitly stage the migration, new SQL test/benchmark/shared JSON fixture and operator guide. `git diff --cached --check` must pass. Tasks 1 and 2 now form one additive migration; never deploy just Task 1's intermediate version.

## Task 3: Shared Python reader, bounded transport and strict parity CLI

**Files:** Create `services/api/app/services/airfare_history_pages.py` and `services/api/tests/fares/test_airfare_history_pages.py`. Modify `airfare_supabase.py`, `airfare_data.py`, `scripts/fares-supabase.py` and their three existing test files from the file map.

**Interfaces:** Consumes the locked core RPCs/shared fixture. Produces `SupabaseAirfare.read_history(params, *, cancel_event=None) -> dict[str, Any]` and internal async `assemble_history(rpc, params, *, check_cancelled, sleep)`. Existing `rpc`, importer upserts, `AirfareData.history` and CLI public arguments remain compatible. No local fallback inside the new reader or CLI.

- [ ] **Step 1: Write the shared-fixture assembly RED test.**

Load the repository JSON via `Path(__file__).resolve().parents[4] / 'fixtures/airfare-history-pagination/v1.json'` (the test is under `services/api/tests/fares`). Read it once as ordinary test data. Each test deep-copies mutable responses. Define a FIFO async callable locally in the test, not a new production mock abstraction:

```python
def test_complete_history_from_shared_wire_fixture():
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    replies = iter([fixture["meta"], *fixture["snapshotPages"],
                    *fixture["baselinePages"], fixture["meta"]])
    calls = []

    async def rpc(name, params):
        calls.append((name, dict(params)))
        return copy.deepcopy(next(replies))

    result = asyncio.run(assemble_history(
        rpc, fixture["filters"], check_cancelled=lambda: None, sleep=asyncio.sleep,
    ))
    assert result == fixture["expected"]
    assert calls[-1][1]["p_expected_revision"] == fixture["meta"]["revision"]
    assert all(name != "read_airfare_history" for name, _ in calls)
```

Define `FIXTURE_PATH` as above; import asyncio/copy/json/Path and the new helper. Run:

```powershell
services/api/.venv/Scripts/python.exe -m pytest services/api/tests/fares/test_airfare_history_pages.py -q
```

Expected RED: missing helper module. Define separate tests for each Review Focus item, not one permissive smoke test.

- [ ] **Step 2: Implement exact protocol validators and one-attempt assembly.**

Private helpers in the new module: `parse_meta(value, params) -> dict[str, Any]`, `parse_page(value, meta, dataset, previous) -> dict[str, Any]`, and `read_attempt(rpc, params, *, check_cancelled) -> dict[str, Any]` (async). `previous` is the prior `HistoryCursor` dictionary or None. Validate object shapes, required field types, route, decimal syntax/range, tuple/ID agreement, dataset and binding. Python int handles exact count/source comparisons. Snapshot tuples compare text, int(source line), ID; baseline tuples compare date text/date text/ID. Reject nonobjects and booleans masquerading as counts. Validate health/airport/reference shapes consistent with current response types; keep existing downstream domain checks too.

`read_attempt` reads meta, creates fresh lists and per-dataset ID sets, skips zero counts, then requests sequential pages with size 100. Reject repeated IDs, nonincreasing order, an empty nonterminal page, non-null cursor not exactly matching the last item, terminal count mismatch, or count overflow before the next request. Check continuity against the prior page's last item even when its cursor looks valid. At dataset exhaustion, final metadata uses `p_expected_revision`; compare all metadata fields structurally, including nested summaries and exact counts. Return only origin/destination/snapshots/baseline/health/airports/pairReference, using original payload dictionaries without modifying them.

```python
async def assemble_history(rpc, params, *, check_cancelled, sleep):
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
```

`read_attempt` checks cancellation before every request and immediately before returning. Do not catch protocol/network errors in this retry loop. Keep accumulator variables inside `read_attempt` so conflict restarts cannot retain old items.

- [ ] **Step 3: Add allow-listed transport error decoding before generic HTTP mapping.**

Extract shared private `_decode_response(response: httpx.Response) -> Any` in `airfare_supabase.py`; both synchronous `_request` and the new async history transport call it. Preserve redirect handling, safe status-only diagnostics and existing JSON handling. Read an error body only to recognize allow-listed code/message pairs, never interpolate it:

```python
if response.status_code >= 400:
    try:
        error = response.json()
    except ValueError:
        error = None
    if isinstance(error, dict) and (
        error.get("code") == "40001"
        and error.get("message") == "airfare_history_revision_changed"
    ):
        raise AirfareHistoryRevisionChanged("Airfare history revision changed")
```

Before generic status mapping, map the fixed protocol-error pairs from the locked interface (22023 request/cursor/size errors and 55000 missing revision) to sanitized `AirfareRemoteRejected`, including if PostgREST wraps one in HTTP 500. Then preserve 429/5xx unavailable versus other 4xx rejected mapping. A different 40001 never restarts; its HTTP status still determines the existing generic classification. Keep credentials, response content and exception chaining out of errors. Add transport tests for exact conflict on HTTP 500, wrong message, malformed JSON, 403, 429, 57014, missing revision 55000 and oversized-item 22023; assert a sentinel secret in arbitrary server details appears nowhere in traceback/log output.

- [ ] **Step 4: Enforce active-request cancellation and the full deadline without raising request timeouts.**

Keep normal sync `rpc`/upserts unchanged. For `read_history` only, create a scoped `httpx.AsyncClient` with the same validated base URL, apikey-only auth policy, configured per-request timeout and `follow_redirects=False`. Use an optional async test transport constructor argument, separate from the existing sync `transport`; do not share a sync-only transport with an async client. Do not close the global client to cancel one history read.

Run its async operation in a dedicated `ThreadPoolExecutor(max_workers=1)` so the synchronous method works even when called from a thread with an active event loop. This is one worker per complete read, not one per page. Inside it, `asyncio.run` enters `asyncio.timeout(remaining_budget)` around the scoped client and full assembly, including retries/backoff. Capture the monotonic deadline at synchronous method entry, before starting the worker; derive remaining budget when the coroutine begins.

When `cancel_event` is provided, race the assembly task against an async watcher checking `cancel_event.is_set()` every 20ms. On cancellation cancel and await the assembly task, close the scoped client, then raise sanitized unavailable. Cancel and await the watcher on normal completion. The transport uses awaited HTTP calls, so timeout/cancellation cancels active I/O, not just the next page. Translate httpx network/timeout and asyncio timeout into unavailable, and check the event/deadline once more before synchronous return. Never leave a background future fetching pages after the caller has received an error.

Use this cancellation primitive inside the operation (declare `operation` and `watcher` as asyncio tasks around the assembly and the polling coroutine):

```python
done, _ = await asyncio.wait({operation, watcher}, return_when=asyncio.FIRST_COMPLETED)
if watcher in done:
    operation.cancel()
    await asyncio.gather(operation, return_exceptions=True)
    raise AirfareRemoteUnavailable("Airfare history read cancelled")
watcher.cancel()
await asyncio.gather(watcher, return_exceptions=True)
return await operation
```

Ensure a `finally` cancels/awaits both tasks on deadline or transport failure as well. Unit-test hung async transport and slowly streaming response bodies: the whole deadline must win even if individual reads keep arriving within httpx's per-phase timeout. Inject a private short test budget/clock, never reduce the production 60 seconds or sleep a minute in tests.

- [ ] **Step 5: Integrate the complete reader and expand parity queries.**

In `AirfareData._remote_history`, replace only acquisition with:

```python
document = remote.read_history({
    "p_origin": query.origin,
    "p_destination": query.destination,
    "p_departure": query.departure,
    "p_snapshot_months": list(query.snapshot_months) or None,
    "p_since": query.since,
    "p_until": query.until,
})
```

Retain every following `_object`, route/order/baseline/domain check. Update test doubles to implement `read_history`; use at least one real SupabaseAirfare mock-HTTP integration through this boundary.

For `compare_reads`, preserve each monthly comparison and calendar read. For each departure also compare snapshots across the route's complete watched month set, while baseline/health remain scoped to that departure. Build explicit `(departure, requested_months)` cases, deduplicate identical cases for single-month routes, and include months in report labels so results cannot overwrite one another:

```python
cases = list(dict.fromkeys(
    (departure, selected)
    for departure in snapshot_months
    for selected in ((departure,), snapshot_months)
))
```

Select local snapshot rows by `row['flight_date'][:7] in requested_months`, retain global captured/source/ID order, and call `remote.read_history` with the exact same six filters. Keep baseline, health, airport and pair-reference expected calculations independent of production pagination. Never catch unavailable and substitute the local expected answer. Report strict failure with no successful parity artifact on a late-page error.

- [ ] **Step 6: Complete lifecycle tests and run GREEN.**

Parametrize fixture mutations: duplicate/missing/extra item, source-line numeric rather than string, >bigint max, counts beyond JS safe range, route/key/revision mismatch, regressing/repeated cursor, wrong dataset, cursor not matching final item, empty nonterminal page and modified final metadata. Assert rejected and no returned document. Test one conflict then success, conflicts at final validation, exactly three exhausted attempts, only 100/250ms backoffs, zero-count metadata/final-meta only, and no retry on late network/permission/size failure. Verify cancellation before first request, between pages, during active I/O and during each backoff; no later RPC is issued.

Through `AirfareData`, unavailable/deadline/churn must log fallback and return complete local data; rejected must not fall back. Through CLI `compare_reads`, the same unavailable must fail strictly. Preserve importer manifest/replay tests unchanged in meaning; replace old RPC assumptions only where history transport changed.

Run focused tests, then `npm run api:test`, `npm run lint:api` and `npm run typecheck:api`. Any real failure is a blocker, not permission to relax strict parsing.

- [ ] **Step 7: Commit the explicit Task 3 file list with `feat: assemble paginated airfare history in Python`.**

## Task 4: Browser assembly, signal propagation and query retry policy

**Files:** Create the TypeScript helper/test; modify the two adapter files and two hook files listed in the file map. Do not modify global QueryProvider retry policy or shared archive polling options.

**Interfaces:** Consumes the same shared fixture and owner RPC signatures. Produces `assembleHistory(rpc, params, signal?) -> Promise<FareHistoryResponse>` and extends `HistoryOptions` with signal. Existing public `fetchFareHistory` response and hook query keys remain unchanged.

- [ ] **Step 1: Write a shared-fixture RED test.**

Import the JSON as raw text with Vite `?raw` and parse it as `unknown` in test setup, then narrow through test-local shape assertions. From the data directory the relative path is `../../../../../../fixtures/airfare-history-pagination/v1.json?raw`. This avoids adding a TypeScript compiler setting just for fixtures. Set up FIFO replies and a spy:

```typescript
it('publishes only the complete shared expected document', async () => {
  const replies = [fixture.meta, ...fixture.snapshotPages, ...fixture.baselinePages, fixture.meta];
  const rpc = vi.fn(async () => structuredClone(replies.shift()));
  await expect(assembleHistory(rpc, fixture.filters)).resolves.toEqual(fixture.expected);
  expect(rpc.mock.calls).toHaveLength(5);
});
```

Define `fixture` using the hand-authored JSON's documented shape in the test; there are two snapshot pages and one baseline page. Run:

```powershell
npm run test -w web -- src/features/airfare/data/airfareHistoryPages.test.ts
```

Expected RED: new module missing.

- [ ] **Step 2: Implement strict validators and attempt assembly.**

Declare the locked wire types in `airfareHistoryPages.ts`, importing `FareHistoryResponse`. Add `parseMeta(value: unknown, params: Record<string, unknown>): HistoryMeta`, `parsePage(value: unknown, meta: HistoryMeta, dataset: Dataset, previous: HistoryCursor | null): HistoryPage`, and async `readAttempt(rpc: HistoryRpc, params: Record<string, unknown>, signal: AbortSignal): Promise<FareHistoryResponse>`. Keep these internal; only export assembly and the typed revision exception needed by the adapter.

Narrow unknown objects and each required field before accessing them; a cast alone is not validation. Match the Python validation contract. Use `BigInt` after decimal syntax/range checks for counts and source lines; never Number, parseInt or arithmetic on numeric-converted cursor values. Compare the captured text/date fields lexically, then bigint line/ID as appropriate. Confirm actual PostgreSQL comparison equivalence on the stored timestamp/date character set in SQL fixtures; do not introduce localeCompare sorting or parse timestamps into milliseconds. Retain original order and payloads.

Track exact counts using bigint and per-dataset IDs using Set. Validate every row and nextCursor against the previous row and current metadata. Final metadata must be structurally equal independent of JSON object key insertion order, not compared with unsorted JSON.stringify. Compare arrays in order and object keys recursively. Return the seven legacy fields only after final validation and `signal.throwIfAborted()`.

- [ ] **Step 3: Implement deadline/cancelable retry lifecycle and adapter.**

Create one AbortController for the entire operation; forward the caller signal (including already aborted), start one 60-second timer, and clear timer/listener in finally. The same derived signal reaches every RPC and each backoff. Only exact `HistoryRevisionChanged` is retried, at most twice. Export this error as an ordinary class with no copied server message. Abort wins over a simultaneous revision error.

```typescript
for (let attempt = 0; attempt < 3; attempt += 1) {
  signal.throwIfAborted();
  try {
    return await readAttempt(rpc, params, signal);
  } catch (error) {
    signal.throwIfAborted();
    if (!(error instanceof HistoryRevisionChanged) || attempt === 2) throw error;
    await abortableDelay([100, 250][attempt], signal);
  }
}
throw new Error('Airfare history is unavailable.');
```

Define `abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void>` in the helper: reject immediately if aborted, otherwise register one abort listener which clears its timer and rejects with the signal reason; clear listener on resolve. The enclosing function uses the derived signal, not the optional original signal in this loop. Deadline reason is a sanitized unavailable error; caller abort retains cancellation semantics. Check cancellation again at the final publication boundary.

In `supabaseAirfare.ts`, the adapter awaits `.abortSignal(signal)` on each owner RPC builder:

```typescript
const { data, error } = await supabase.rpc(name, params).abortSignal(signal);
signal.throwIfAborted();
if (error?.code === '40001' && error.message === 'airfare_history_revision_changed') {
  throw new HistoryRevisionChanged();
}
return rpcResult<unknown>(data, error);
```

Continue sanitizing all other server errors with existing status/code-only behavior. Do not pass messages/details into logs. Calendar and airport-search methods stay on existing RPCs. Replace inaccurate existing test history responses (`baselines`, array health, missing metadata) with actual protocol fixtures and a thenable RPC mock supporting abortSignal.

- [ ] **Step 4: Test the actual hook with an enabled QueryClient.**

Add `retry: false` after `...archiveQueryOptions` in `useFareHistory`; preserve key, enabled condition, polling/invalidation and stale/cache settings. Replace the current hook-named adapter-only test with a rendered hook using QueryClientProvider and `renderHook`. Configure the test client default retry to 1, proving this hook overrides it. Disable scheduled intervals only in the isolated assertion's test setup or advance fake timers less than the existing 15-second failure refetch interval; do not change production polling.

```typescript
expect(client.getQueryState(key)?.status).toBe('error');
expect(client.getQueryData(key)).toBeUndefined();
expect(metadataStarts).toBe(3);
```

Define `key` from the actual route/departure/month-set key, and increment `metadataStarts` in the mocked owner-metadata RPC on calls without expected revision. Trigger three exact revision conflicts and advance fake timers through 100ms/250ms plus the default outer retry interval; still exactly three starts. With a preexisting complete cache value, a later failed read retains only that old complete value and exposes an error. Do not count a deliberately triggered scheduled refetch as an internal retry.

- [ ] **Step 5: Complete rejection/cancellation tests and run GREEN.**

Mirror Python fixture mutations and exact count/cursor checks. Test byte-trimmed pages without assuming every nonterminal page has 100 rows. Use fake timers for whole-budget exhaustion and each backoff; use a controlled pending RPC for in-flight abort. Assert all builders receive the derived signal, abort stops subsequent calls, listeners/timers are cleaned, and late resolved promises cannot publish. Check immediate cancel on entry, final-validation conflict, third conflict, wrong 40001 message and no legacy-RPC fallback.

Run focused helper/adapter/hook tests; then `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`. Keep existing query-key and month-set assertions. No product code commit until these pass.

- [ ] **Step 6: Commit the explicit six Task 4 paths with `feat: read complete airfare history through owner pages`.**

## Task 5: Real concurrent readers/writers and whole-branch acceptance

**Files:** Create `scripts/test-airfare-history-concurrency.ps1`; extend both new SQL tests, SQL benchmark, Python protocol/integration tests and `docs/airfare-history-pagination.md` as necessary. Preserve the shared fixture's independent expected document.

**Interfaces:** Consumes the actual installed new migration in the disposable database produced by Task 1. Produces an executable `-Database <name>` test entry point, an exit-zero/exit-nonzero concurrency verdict and payload-free timing/count output. The runner never accepts a hosted URL or the database name `postgres`.

- [ ] **Step 1: Create a failing real-session mutation schedule.**

Start two independent long-lived `docker exec -i supabase_db_edicius-hq psql -U postgres -d <validated-test-db> -X -At -v ON_ERROR_STOP=1` processes via redirected pipes, using the Task 1 name validation. Set process-specific application_name and bounded statement/lock timeouts only for the local harness; do not raise hosted deadlines. Read an explicit `\echo` marker before advancing a barrier, with a harness deadline that terminates only its own child processes on failure. No timing-only sleeps to assume a transaction has committed.

In session A insert synthetic route `CON-DST` data and commit, read metadata and page 1 with size 1, retaining revision/cursor. In session B insert a new row ordered before A's cursor, then COMMIT and emit `writer_committed`. A's next page with the old revision must report exactly `40001/airfare_history_revision_changed` and no payload. For error assertions, catch expected SQL exceptions within a DO block and print a fixed pass/fail marker; an unexpected success must raise, causing nonzero psql exit.

```sql
do $$
begin
  perform public.read_airfare_history_page(
    'CON','DST',null,null,null,null,
    current_setting('test.old_revision'),'snapshots',null,1);
  raise exception 'stale read unexpectedly succeeded';
exception when serialization_failure then
  if sqlerrm <> 'airfare_history_revision_changed' then raise; end if;
end;
$$;
```

Set `test.old_revision` inside session A from its real earlier metadata, not a hard-coded value. Exercise the saved cursor as well as null in separate assertions. Before implementing the protocol, this schedule would fail; now run it against a deliberately stale expected revision to prove the harness observes the intended error, and a current revision to prove it detects unexpected success.

- [ ] **Step 2: Extend the schedule to each data dependency and rollback.**

Run independent seeded cases for source_line moved backward, same-natural-key baseline replacement, health update, airport update, insert/update/delete/truncate on each tracked table, and a mutation immediately before final metadata. DELETE/TRUNCATE cases run only as local postgres; assert service_role still cannot use forbidden mutations. Do not grant extra privileges to make tests pass.

For each case, session A holds the initial revision; session B writes and stays uncommitted. A's next read must still see a self-consistent prior committed revision without blocking on the counter. After B rollback, A continues successfully and final metadata matches; after B commit, the next page/final validation rejects. Verify a long statement's internal reads share its snapshot using a third controller connection with an advisory-lock barrier: session A starts a statement that establishes a snapshot and waits, controller confirms A's lock wait via pg_locks, B commits, controller releases the lock, and A finishes reading the old consistent revision. The following statement must reject that revision. Bound every wait and release only harness-owned advisory locks.

Add two simultaneous writer sessions to show counter updates serialize safely and both commits advance monotonically; confirm rolled-back writes leave no committed increment. Include a real importer replay via existing `AirfareSync` integration with a test-only local adapter in `services/api/tests/fares/test_airfare_history_pages.py`: `LocalReplica.upsert(table, rows, *, on_conflict)` executes the real batched upsert and `LocalReplica.rpc(name, params)` calls the real SQL function in the validated disposable database. Match additional read methods actually consumed by `AirfareSync` to the existing `SupabaseAirfare` signatures; retain their real SQL behavior, not hard-coded verification results. Use subprocess psql input and safely quoted psql variable binding for JSON parameters, with table/column/function identifiers checked against explicit test allowlists. Do not relax the production HTTPS project-host allowlist to reach local Docker. Execute as service_role, retain the importer's real batching/conflict keys and never fake revision updates.

- [ ] **Step 3: Connect concurrent revisions to real reader behavior.**

Feed actual SQL RPC responses from the isolated database into the Python reader's injected async RPC boundary, pause at a page boundary, then perform the writer schedule. Assert the first attempt's items are discarded, subsequent successful result equals one complete post-commit legacy SQL result, and repeated writes exhaust exactly three attempts without a return value. For the browser, reuse the same captured nonsecret synthetic wire responses plus live adapter tests; hosted Task 6 covers the real owner HTTP path. Do not use canned mutation responses as the only database-concurrency test.

Rehash retained source and destination archive manifests before/after read-only parity and replay validation. The database test may replay into its isolated replica; it must not modify archived files or the production collector runtime. Preserve expected importer totals and content identities.

- [ ] **Step 4: Run the whole validation matrix.**

From the correct worktree, run each command separately and stop on failure:

```powershell
./scripts/test-airfare-history-pagination.ps1 -Database $testDatabase
./scripts/test-airfare-history-concurrency.ps1 -Database $testDatabase
npm run api:test
services/api/.venv/Scripts/python.exe -m pytest ops/pi/tests -q
npm test
npm run lint:api
npm run typecheck:api
npm run lint
npm run typecheck
npm run build
git diff --check
```

`$testDatabase` is the previously printed validated disposable name, not an environment variable or the shared database. With no `-Tests`, the SQL runner executes all files under `supabase/tests` in sorted order and requires each pgTAP plan to pass. Run the opt-in benchmark separately and retain its result; do not fold performance thresholds into flaky ordinary unit tests. Record fresh totals and existing warnings rather than copying historical 909/2259 counts as if current.

- [ ] **Step 5: Independent review and commit.**

Use `superpowers:requesting-code-review` for the complete product diff since `6d91738`, with the approved spec and this plan attached. Review consistency/ACLs/byte budget and both client failure lifecycles, not just code style. Follow the selected execution method's reviewer requirements. Fix actionable findings with regression tests and rerun affected/full gates proportionately. Commit only Task 5 implementation/test/operator-guide paths with `test: verify airfare pagination under concurrent synchronization`. No push, merge or collector activation is implied by a clean local review.

## Task 6: Staged hosted validation and rollout gate

**Files:** Complete `docs/airfare-history-pagination.md`. Create timestamped result artifacts under existing untracked `docs/pi-collectors-evidence/` only when actually running validation; keep them outside product commits unless separately requested. Do not overwrite earlier evidence or modify the retained canonical archive.

**Interfaces:** Consumes a reviewed final commit, passing local gates, existing authorized Supabase administration, a real authorized owner browser session, retained canonical archive and fresh replica parity. Produces measured rollout verdict and exact deployed SHA/migration state. Missing access is a reported blocker, not permission to obtain credentials or bypass wrappers.

- [ ] **Step 1: Prepare the operator gate; obtain direction before hosted changes.**

Write the following commands and gates into the operator guide during implementation, but do not execute hosted writes merely because the local code is complete. Confirm the user wants staged deployment of this reviewed SHA. Recheck the PR head, pending migration list, linked project `abndifkxpfppmllgxfnu`, and Windows/Pi runtime state. Preserve Windows enabled/Pi disabled. If the hosted schema differs from the expected baseline, stop and reconcile before applying anything.

```powershell
npx --yes supabase@2.105.0 projects list --output json
npx --yes supabase@2.105.0 migration list
npx --yes supabase@2.105.0 db push --dry-run
```

Expected dry-run: only `20260919010000_airfare_history_pagination.sql`. Verify the final migration is atomic under the chosen migration runner. If it does not guarantee transactional application, execute the file in an explicit transaction using the approved administration path, and reconcile migration bookkeeping before clients switch. Never deploy a partially installed counter/read protocol. Do not use `db reset --linked`.

- [ ] **Step 2: Deploy database first and verify the actual writer role.**

After the staged-deployment go-ahead and successful dry-run:

```powershell
npx --yes supabase@2.105.0 db push --yes
npx --yes supabase@2.105.0 migration list
```

Verify functions, grants, revision row and four triggers through read-only inspection. Before switching readers, use the authorized existing service-role importer to replay an unchanged, already-replicated record from the retained archive, under its normal conflict key. Compare row payload/identity before and after and require revision advancement. Record this intentionally authorized replica write; do not insert arbitrary production test fares. If the write fails or privileges drift, stop rollout. Do not disable triggers or grant DELETE as a workaround.

- [ ] **Step 3: Validate candidate readers without activating collectors.**

Run strict `scripts/fares-supabase.py --compare-reads` using the retained validation source and a new report path. Read existing service credentials into memory through the established environment loader; never print or put them in command arguments. The concrete retained source at this checkpoint is `C:/Users/krato/AppData/Local/Temp/edicius-reconcile-20260919T065047Z/history-read-validation/fares`; verify its manifest and expected source-root layout before use. Do not reuse an old report name. Use the existing script's `--source` option, not a changed working directory that redirects storage.

For Python per-request metrics, wrap the new scoped async client's public request/send boundary in the private canary harness, measuring elapsed monotonic time and `len(response.content)` after body consumption. Inspect only the known request's RPC name/dataset and allow-listed response/error fields in memory; output counts, sizes, elapsed time and exact revision-restart count. Never log URLs with query data, headers, bodies or arbitrary exception text. The CLI's existing canonical identity/domain digests remain the parity oracle.

For the browser canary, use the actual candidate web build and an existing authorized owner session through `read_owner_airfare_history_meta/page`. Do not fabricate JWTs, replace the browser path with a service-role call, or set request.jwt.claims in administrative SQL and call that a browser test. If no owner session is available, pause for the user to sign in securely; no passwords/tokens in chat. Observe request timings/sizes with browser tooling and summarize only safe aggregate metrics. Unauthorized/non-owner HTTP denial may be checked with existing sessions, without creating new credentials.

- [ ] **Step 4: Run three exact-parity multi-month canary passes.**

For both readers, run AQP-LIM with departure `2026-11` and snapshot months `['2026-11','2026-12']`, each watched route's complete month set for each selected departure, and the retained monthly/calendar comparisons. Every successful logical history response must equal its independent canonical archive/domain expectation. Do not use the timing-out legacy hosted RPC as oracle. Measure each reader separately and compare ordered identity and domain digests.

Record for each of three consecutive passes: route/filter label, snapshot/baseline counts, page count, metadata/page byte maxima, maximum request duration, logical-read duration, restart count and digests. Require every response <=1,048,576 bytes, every metadata/page HTTP request <5 seconds, every logical read <60 seconds, exact counts/digests and zero partial successes. A restart is acceptable only inside the defined budget and with a complete final result. If the live replica changes relative to the frozen oracle, report the mismatch and reconcile a fresh source/replica checkpoint; do not edit the expected digest until it matches.

Represent first/cold and repeated reads explicitly. Never flush hosted production caches. Do not label the first request as proven cold without evidence; supplement it with a controlled isolated cold-cache benchmark and disclose the hosted cache state as unknown. If genuinely cold hosted behavior is required to close the gate and cannot be demonstrated safely, report that limitation and leave that acceptance item open.

Missing owner access, size/latency violation, parity mismatch or local/remote privilege failure blocks consumer rollout/cutover. Do not increase timeouts, reduce month coverage, ignore oversized records or fall back to the legacy giant RPC.

- [ ] **Step 5: Switch the coordinated reader release only after gates pass.**

Deploy web, Python API reader and parity CLI from the same reviewed commit using the existing release workflow. The candidate build may be exercised before the production switch; database support must already exist. Record release SHAs, migration state and verified rollback target. Keep both legacy RPCs and all new database objects installed. Re-run the representative owner/service reads after the switch and confirm old calendar/search functionality still works.

Rollback means restore the prior application reader release and, where applicable, its documented local backend setting. Preserve replica data, migration objects and original archives. A trigger incident requires a separately reviewed corrective migration, not silently disabling revision protection. The prior application's known multi-month timeout returns on rollback; do not call that cutover-ready.

- [ ] **Step 6: Stop at the collector cutover boundary and report status.**

This plan does not activate collectors. A later Task 11 cutover requires fresh Windows/Pi delta reconciliation, canonical/replica parity, secure Pi administration and all runtime gates from the retained handoff. Native `sudo -n` last required renewed interactive authentication; do not reuse a closed broker or retrieve stored passwords. Keep Windows enabled and Pi entry points disabled until that separately authorized procedure. Do not start or claim the 24-hour/seven-day windows here.

## Self-review and execution handoff

Coverage: spec filter/metadata/ACL/revision requirements map to Task 1; page/cursor/size/index requirements to Task 2; Python transport/fallback/CLI to Task 3; browser cancellation/cache/retry to Task 4; real concurrency/replay/full suites/review to Task 5; actual owner/service acceptance, migration order and rollback to Task 6. Each Review Focus condition has an explicit owning test step.

No product changes or hosted actions have been performed by writing this plan. Review it and choose execution before implementation. Native execution keeps these tightly coupled SQL/Python/TypeScript interfaces in one context and adds independent whole-branch review at the end; subagent-driven execution adds a fresh implementation/review gate per task, at greater coordination/context cost. For this plan, Native is recommended because all six tasks share one protocol and the final concurrency/security review remains mandatory.
