# Reduce Airfare disk I/O

## Intent and evidence

Investigate the November 5 Supabase Disk IO Budget warning and prepare a branch
that reduces avoidable work without deploying it. Read-only production inspection
on November 6 found a 613 MB database and healthy status. Since September 15,
`refresh_fare_route_projection` accumulated 10,067 calls, 1,642 GiB of temporary
writes (95.6% of statement temporary writes), and 7.3 seconds per call. The global
manifest accumulated 69 GiB and 7.9 seconds per call. These are historical totals,
not a measurement of the warning's exact interval or remaining budget.

## Constraints

- Preserve the authoritative Pi archive, replica data, retention, collection cadence,
  owner authorization, dirty-route locking, and retry semantics in ADR 0004.
- Preserve exact month/flight results, including confirmed-empty availability,
  unpriced sightings, first priced offer metadata, event ordering, and pair reference.
- No production migrations, resets, pruning, compute upgrades, or global memory changes.
- Baseline content acknowledgements already exist; historical update counts do not
  prove that current code still replays every baseline.

## Approaches

Increasing compute or global work memory could mask repeated work and introduces
cost or concurrency risks. Reducing collection frequency would reduce freshness.
The implementation choice is to reduce SQL intermediate width and persistent
rewrites, and reserve global manifest scans for explicit audit/full-import paths.
This follows the user's request to optimize in a branch; no product tradeoff or
deployment is included.

## Changes

1. Narrow month snapshot/event CTEs. Sort scalar references to historical offers;
   fetch the original JSON only for the selected first priced offer. Replace the
   complete ordered JSON array used to retain one offer with deterministic selection.
2. Upsert only changed flight projections and delete only obsolete projection keys.
   A refresh still processes every dirty month and publishes current check state.
3. Routine collector and CLI incremental synchronization omit the global destination
   manifest. Full apply and explicit verification retain it. An omitted manifest is
   unobserved, not evidence that the replica is empty or reconciled.

## Verification

Use an isolated PostgreSQL 17 container with synthetic data and no network. Compare
the complete prior/new month and flight results, exercise event ties and price
reversion, and assert unchanged projections retain their physical row versions.
Benchmark temporary blocks, WAL, and elapsed time at the observed 2184 kB work_mem.
Run existing SQL regression tests and Python suites. Document deferred work (metadata
reuploads and splitting check-only refreshes) rather than changing their contracts
without evidence. Measured local improvement is not a promised production percentage.
