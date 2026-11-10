# Supabase operational retention

The Airfare archive on the Pi remains authoritative; its Supabase tables and the
read projections remain available. This change targets only operational records:
completed or failed Airfare import runs and terminal collector requests older
than seven days. Active requests, recent terminal requests, and running imports
are never pruned. `market_bars` stays available as a stale-while-refresh cache.

Routine unscoped incremental Airfare sync stores dataset totals and digests in
`airfare_import_runs.source_manifest`, omitting repeated per-route detail. Its
in-memory `SyncReport` and explicit full/verification paths retain the full
manifest. The destination manifest remains unobserved for routine sync.

The database RPC returns candidate counts in dry-run mode and removes at most
500 rows per table per apply call. The Pi job logs only counts. Deployment must
apply the migration before installing the Pi release, because `verify.sh` calls
the RPC in dry-run mode. The installer and release deploy do not enable the new
timer. On rollback, disable the timer; the migration may remain installed
because no existing reader depends on it.

The November 10 read-only inspection measured 652 MB total DB size. Seven-day
retention matched 4,116 import runs with about 62 MB of logical manifest data,
and 1,408 requests with about 35 MB of logical result data. These are estimates
of content removed, not a guarantee that Postgres will report a 97 MB smaller
database. Recheck `supabase inspect db db-stats --linked` after a cleanup and
plan physical reclamation separately if the size remains above quota.

## Production sequence after PR merge

1. Confirm the linked project ref is `abndifkxpfppmllgxfnu`. Run `supabase
   migration list --linked` and `supabase db push --linked --dry-run`; require
   exactly `20261110000000_operational_retention.sql` pending. Apply that
   migration and check that the migration list matches.
2. Query `select public.prune_operational_history(false, 500);` as the service
   role. Compare candidate counts to a fresh read-only inventory. Do not use
   `true` during preflight.
3. Deploy the pinned Pi release through the existing release script. Its
   verifier runs the retention CLI without `--apply`, proving the RPC exists and
   the service identity can call it. The timer remains disabled on first deploy.
4. After reviewing that output, explicitly enable the new timer with
   `systemctl enable --now edicius-retention.timer`. Inspect the service journal
   after the first run and query candidate counts again. Disable the timer on
   rollback; it does not remove the database function or restore deleted rows.

This rollout does not perform `VACUUM FULL` or other physical compaction.
Plan that separately after measuring the post-retention database size and disk
headroom, since compaction can lock tables and use additional space.
