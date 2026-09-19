# Airfare history pagination

Implementation follows the [approved design](superpowers/specs/2026-09-19-airfare-history-pagination-design.md)
and [execution plan](superpowers/plans/2026-09-19-airfare-history-pagination.md).
This is an additive read transport, not a new archive authority or collector cutover.

## Local SQL verification

From the `pi-collectors-supabase` worktree in PowerShell:

```powershell
./scripts/test-airfare-history-pagination.ps1 -Create
```

Keep the printed `airfare_pagination_test_<32 hex digits>` database name. Rerun with
`-Database` and that name; use `-Tests @('supabase/tests/airfare_history_revision.test.sql')`
to select a test file. No `-Tests` runs the full pgTAP suite. The runner checks both
SQL exit status and TAP assertion counts/failures.

The runner clones only schema from the existing local Docker database, into a new
isolated database. It retains object ACLs and postgres default privileges; managed
Supabase-role default privileges are excluded because postgres cannot alter them.
Realtime publication membership is copied separately, without subscriptions.
Missing repository baseline migrations after the collector data plane are applied
only to the clone. pgTAP is installed there. Every SQL test rolls back its fixtures.
Test databases are retained, never automatically dropped. The shared `postgres`
database, hosted Supabase, collector runtimes and archives are not modified.

## Revision and metadata

`read_airfare_history_meta` is service-role-only. The matching
`read_owner_airfare_history_meta` verifies the existing owner allowlist on each call.
Both accept the existing six filters plus optional `p_expected_revision`.
Metadata returns protocol version 1, an opaque query key, decimal-string revision
and counts, route, complete health, origin-first airports and whole-pair reference.
It never materializes snapshot or baseline payload arrays. Metadata is bounded to
1 MiB in UTF-8, failing explicitly rather than dropping fields.

One RLS-protected singleton counter advances transactionally on statements that
insert, update, delete or truncate snapshots, baseline, checks or airports. Browser
roles cannot access it directly; service_role can only select it. The trigger's
security-definer function has an empty search path and no direct client execution
grant. A rollback restores data and counter together. Replays may increment more
than once; consumers rely on monotonic change, not a fixed delta.

Null snapshot months mean whole-route history; an empty array means no snapshots.
Departure scopes baseline/health independently. Duplicate months and equivalent
empty optional filters share a query key. The key is not an authorization token.

## Bounded pages

`read_airfare_history_page` and `read_owner_airfare_history_page` accept the six
filters, decimal-string `p_revision`, `p_dataset` (`snapshots` or `baseline`),
optional JSON `p_cursor`, and `p_page_size` (default 100, range 1–250).
The cursor binds version, query key, revision, dataset and the last ordering tuple.
Snapshots order by captured text, bigint source line and content ID; baseline by
flight date, price date and content ID. Bigints are decimal strings on the wire.

Selection limits key-only candidates before joining original payloads. Each complete
page is at most 1 MiB; byte-limited pages can contain fewer than the requested rows.
Only a null next cursor signals exhaustion. A single oversized item fails with
`22023/airfare_history_item_too_large`; stale revisions fail with
`40001/airfare_history_revision_changed`. Neither error means an empty dataset.

The opt-in `supabase/benchmarks/airfare_history_pagination.sql` seeds synthetic data
inside a transaction and rolls back both fixtures and candidate indexes. Run it only
in the printed isolated test database. It measures key selection, bounded RPCs and
250-row service-role upserts against an equally indexed trigger-free temporary
control table. It never disables the revision guard or flushes production caches.

## Python reads and parity

`SupabaseAirfare.read_history` assembles snapshot pages, then baseline pages, and
revalidates metadata before returning the legacy document. Counts and source-line
values are parsed exactly; duplicate identities, nonincreasing order, changed
bindings, incomplete counts and malformed terminal cursors reject the entire read.
Original payload objects are preserved. Zero-count datasets skip pages, not the
final metadata check.

Only the exact revision conflict restarts a read: three attempts maximum with
100/250-ms backoffs. A scoped async HTTP client allows cancellation/deadline to stop
active I/O without closing the shared replication client. A 60-second total budget
includes requests and backoffs; configured per-request timeouts do not increase.
The synchronous entry point also works when the caller already has an event loop.

Temporary failures and exhausted revision churn remain logged local fallback in
`AirfareData`. Permission/protocol/size failures do not fall back. The parity CLI
calls the strict remote reader directly and compares both monthly queries and each
departure with the complete watched-month snapshot set. A failed remote read cannot
be disguised as parity with local data. Calendar and airport-search reads do not
use this pagination protocol.

## Deployment boundary

Do not deploy intermediate implementation commits. The complete migration must
install revision tracking and all four RPCs atomically before consumers switch.
Hosted deployment requires the separate operator gate in the approved plan, real
owner and service-role canaries, and exact parity/latency evidence. Old history RPCs
remain available. No collector is activated by local implementation or validation.
Rollback restores the prior application reader/local backend setting, never deletes
archive or replica data, and never silently disables revision triggers.

## Browser lifecycle

The owner adapter uses the same assembly contract as Python. One derived abort
signal reaches every request and both retry delays; one 60-second timer covers the
entire logical read. Cancellation wins over a revision conflict. The query disables
outer retries, but keeps its existing route/departure/month-set cache identity,
scheduled refresh, stale time and old-complete-data-on-error behavior. No partial
page array is exposed to React Query. Calendar and search are unchanged.

## Concurrency and complete local gates

Use only the disposable database printed by the SQL runner, never `postgres` or a
hosted connection. The concurrency runner uses persistent local Docker/psql sessions
with explicit output barriers, bounded waits, real service-role writes and a third
lock observer. DELETE/TRUNCATE are exercised only by the local administrator;
service_role receives no additional grants. The test-owned synthetic rows are
cleared between/after schedules so the original pgTAP fixtures remain independent.
The database, revision counter and execution logs remain retained.

```powershell
$testDatabase = 'airfare_pagination_test_3c9e7cf14aac4f48a9ddc274402a1582'
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

Run commands separately and stop at the first nonzero exit. Ordinary API tests skip
the opt-in Docker schedules; the concurrency command must also pass. It covers
behind-cursor inserts, backward source positions, natural-key replacement, every
tracked mutation, rollback, a statement spanning a commit, serialized concurrent
writers, reader restart/exhaustion and real `AirfareSync` full/replay verification.
The importer's synthetic source files are hashed before/after; its own cursor lives
only in pytest's temporary source. Retained archives are never used as writable
importer fixtures. TRUNCATE holds PostgreSQL's relation lock: rollback must unblock
the read unchanged, and a read started after commit must reject the old revision.
Ordinary uncommitted mutations do not block history on the revision counter.

`fixtures/airfare-history-pagination/v1.json` remains the independent hand-authored
cross-language oracle. `sql-session.json` additionally captures actual local SQL
responses for the synthetic CON-DST schedule (one-row pages and legacy SQL result),
reused by the browser's final-conflict/discard test. Its revision is a captured
opaque decimal value, not a production revision or a required counter starting point.

## Staged hosted deployment — separate approval required

Local success is not hosted acceptance. First obtain explicit approval to stage
the reviewed commit. Do not push, merge, switch consumers or run hosted writes just
because local tests pass. Record the approved SHA with `git rev-parse HEAD` and
inspect PR 203's head/checks, the linked project and runtime states again. The last
checkpoint had Windows Airfare enabled and all four Pi entry points disabled; do
not change those states in this pagination rollout.

```powershell
git rev-parse HEAD
gh pr view 203 --json headRefOid,state,statusCheckRollup
npx --yes supabase@2.105.0 projects list --output json
npx --yes supabase@2.105.0 migration list
npx --yes supabase@2.105.0 db push --dry-run
```

Require linked project `abndifkxpfppmllgxfnu`, the expected deployed baseline through
`20260919000000`, and exactly one pending file:
`20260919010000_airfare_history_pagination.sql`. Any drift blocks this procedure.
Confirm that the selected migration runner applies the entire file transactionally.
If it does not, use the existing authorized administration path with an explicit
transaction and reconcile migration bookkeeping before switching any consumer.
Do not use `db reset --linked`, a partially installed protocol, or new credentials.

After approval, dry-run and atomicity checks, deploy **database first**:

```powershell
npx --yes supabase@2.105.0 db push --yes
npx --yes supabase@2.105.0 migration list
```

Inspect the four functions, singleton row, four mutation triggers and ACLs read-only.
Then explicitly record one normal service-role replay of an unchanged, already
replicated archive record under its actual conflict key. Require identical payload
and identity before/after and revision advancement. This is an intentional replica
write, not an arbitrary test fare. Failure blocks reader rollout; do not disable a
trigger, grant DELETE, or rerun the full backfill as a workaround.

### Candidate canaries, without collector activation

Verify the retained canonical manifest first. At this checkpoint the archive files
are in `C:/Users/krato/AppData/Local/Temp/edicius-reconcile-20260919T065047Z/history-read-validation/fares`.
The CLI takes its **parent source root**, because it resolves `fares/` beneath that
root. Require the expected watch document and source layout as well; an empty scan
does not prove parity. Rehash the PC source, Pi source and candidate against their
retained manifests before and after canaries. Never modify those archives or reuse
an earlier report path.

```powershell
$validationRoot = 'C:/Users/krato/AppData/Local/Temp/edicius-reconcile-20260919T065047Z/history-read-validation'
$report = 'docs/pi-collectors-evidence/history-pagination-' + [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffffffZ') + '.json'
if (Test-Path -LiteralPath $report) { throw 'Report already exists' }
npm run fares:supabase -- --compare-reads --source $validationRoot --report $report
```

The established environment loader supplies existing credentials in memory; never
put credentials in arguments, chat, logs or reports. The CLI is strict remote parity,
with no local fallback. For per-request Python metrics, instrument the scoped async
HTTP client's public request/send boundary in a private canary harness: monotonic
elapsed time, consumed body length, RPC/dataset label and restart count only. Do not
log headers, bodies, query values or arbitrary errors.

Exercise the actual candidate web build through both owner RPCs with a real
authorized owner session. If none is available, pause for secure user sign-in.
A service-role request, fabricated JWT or administrative `request.jwt.claims`
setting is **not** a browser canary. Observe browser timings and body sizes without
exporting credentials. Existing anonymous/non-owner sessions may verify denial.

For **each reader**, require three consecutive exact-parity passes covering:

- AQP-LIM, departure `2026-11`, snapshot months `2026-11,2026-12`.
- Every watched route's full month set for each selected departure.
- The retained monthly and calendar comparisons.

For every route/filter/pass record snapshot/baseline counts, page count, maximum
metadata/page bytes, maximum request duration, total logical-read duration, restart
count and ordered identity/domain digests. Require each response <=1,048,576 bytes,
each request <5 seconds, each complete read <60 seconds, exact canonical digests
and zero partial successes. Do not use the timing-out legacy hosted RPC as oracle.
Live replica drift requires a fresh reconciled checkpoint, not editing expected
digests to match. A restart is acceptable only within the existing complete-read
budget. No larger timeout, reduced month coverage or old-RPC fallback is allowed.

Label first and repeated requests explicitly. Hosted cache state is unknown unless
demonstrated; never flush production caches. Supplement with an isolated controlled
cold-cache benchmark if needed, and keep genuinely cold hosted acceptance open when
it cannot be demonstrated safely. Missing owner access or any parity/latency/size/
privilege failure blocks consumer rollout and cutover.

### Coordinated release and rollback

Only after canaries pass, use the existing release workflow to deploy web, Python
API reader and parity CLI from the same reviewed SHA. Record the exact release SHAs,
migration state and prior release target. Recheck representative owner/service
reads plus calendar/search after the switch. Keep both legacy RPCs and all new
database objects installed.

Rollback restores the previous application reader release and its documented local
backend setting where applicable. It retains replica data, original archives,
backups and migrations. A trigger incident requires a separately reviewed corrective
migration, never silently disabling revision protection. Application rollback also
restores the old known multi-month timeout, so it is not cutover acceptance.

Stop at this boundary. A later Task 11 collector cutover needs fresh Windows/Pi
delta reconciliation, canonical/replica parity, secure Pi administration and the
runtime gates in the retained handoff. Renew Pi sudo interactively in a secure
terminal if required; do not recover old passwords or use a closed broker. No
collector activation, Task 12, deletion, merge, or 24-hour/seven-day observation
window is authorized or completed by this guide.
