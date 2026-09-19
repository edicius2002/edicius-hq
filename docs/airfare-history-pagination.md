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

## Deployment boundary

Do not deploy intermediate implementation commits. The complete migration must
install revision tracking and all four RPCs atomically before consumers switch.
Hosted deployment requires the separate operator gate in the approved plan, real
owner and service-role canaries, and exact parity/latency evidence. Old history RPCs
remain available. No collector is activated by local implementation or validation.
Rollback restores the prior application reader/local backend setting, never deletes
archive or replica data, and never silently disables revision triggers.
