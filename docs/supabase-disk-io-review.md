# Supabase disk I/O review — 2026-11-06

Branch: `fix/supabase-disk-io`. The initial review and benchmark preceded deployment.
The owner subsequently authorized production rollout on November 7; see the
[production measurement](supabase-disk-io-production-2026-11-07.md).

## What is written

| Dataset                                       | Write behavior and purpose                                                                                                                                                                                                                                                                                                         |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `fare_snapshots`                              | Content-addressed observed offer boards, including original JSON and source position. Incremental source cursors normally upload only new journal content. Replay can update source ordering metadata.                                                                                                                             |
| `fare_baseline_points`                        | Provider historical prices, upserted by route/departure/price date. Existing durable content acknowledgements avoid uploading unchanged natural keys. Deployment/rollback deliberately invalidates those acknowledgements to recover from older writers.                                                                           |
| `fare_calendar_captures`                      | Content-addressed calendar curves and original JSON.                                                                                                                                                                                                                                                                               |
| `fare_checks`                                 | Board/calendar collection outcomes, including errors, unchanged results and confirmed no-offers. These are necessary for freshness and availability; suppressing unchanged checks would lose information.                                                                                                                          |
| `fare_airports`, `airfare_documents`          | Airport metadata and the recovery copy of the local watch document. Global sync currently reuploads these even when unchanged. The owner document remains the authority defined in ADR 0004.                                                                                                                                       |
| `airfare_import_runs`                         | A running record followed by its completion/failure update, including manifests. This is operational history, not fare observations.                                                                                                                                                                                               |
| Dirty route/month tables and history revision | Triggers record which projection needs rebuilding and invalidate paged history reads. Route-row locks prevent a concurrent collection from losing its dirty marker.                                                                                                                                                                |
| `fare_month_projections`                      | Derived month summaries, current boards, health, and pair reference, rebuilt for dirty months.                                                                                                                                                                                                                                     |
| `fare_flight_projections`                     | Derived per-flight first/current/previous prices, sightings, observation days and availability. Previously every refresh deleted and reinserted the complete affected month.                                                                                                                                                       |
| Other collector tables                        | `collector_runs`/`collector_requests` track status and progress; `market_quotes`/`market_bars` cache provider answers; `tweet_posts`, `sentiment_snapshots`, and `fx_observations` retain their observations; SEACE upserts records and sync state. They are not the dominant temporary-write sources in the inspected statistics. |

The Pi collects Airfare on a 15-minute timer and independently reconciles the replica
every 30 minutes; manual requests also synchronize their route. The database recorded
130 completed incremental imports on November 5, averaging 55.8 seconds. October 31
had 121 completed imports averaging 29.6 seconds. This is correlation, not proof that
a particular deployment caused the warning.

## Evidence and mechanism

Read-only CLI inspection of project `abndifkxpfppmllgxfnu` found:

- Database size: 613 MB; status `ACTIVE_HEALTHY`; no waiting locks or dirty projection
  backlog at the inspection instant; cache hit ratio 99.94%.
- Statement statistics since September 15: route refresh 10,067 calls, 1,642.22 GiB
  temporary writes, 95.59% of tracked statement temporary writes, mean 7,295.62 ms.
- Global manifest: 4,162 calls, 69.34 GiB temporary writes, 4.04%, mean 7,927.25 ms.
- `work_mem`: 2184 kB. PostgreSQL uses temporary files when intermediate operations
  cannot fit their memory allowance; temporary-write totals are not occupied disk space.
- `fare_baseline_points` has about 158,526 live rows and 33,563,030 accumulated updates.
  The current code already has baseline deduplication; those historical counters do
  not establish ongoing redundant baseline uploads.

The prior month SQL materialized complete snapshot JSON, expanded historical offers
with their full JSON in intermediate relations, sorted them repeatedly, and built an
ordered JSON array just to choose its first element. Full delete/reinsert additionally
created heap/index writes and dead tuples. Dirty-month selection already existed;
the problem was the work within each affected month, not an unconditional refresh of
every month in the route.

The manifest reads and sorts identities across all four archive datasets. Routine
incremental callers performed this global audit even when source acknowledgements
and dirty-route recovery were sufficient to complete synchronization.

## Changes in this branch

1. A forward migration keeps scalar snapshot/offer references through the historical
   calculations and fetches the full original JSON only for the first priced offer.
   `DISTINCT ON` replaces the complete ordered offer array. Ordering remains exactly
   the same, including source position, record ID, and array ordinality.
2. Flight projections use a null-safe changed-only upsert plus deletion of obsolete
   keys. Unchanged rows keep their physical versions. Derived rows can still be
   removed after a source replacement; source archives and replica observations are
   never pruned. The upsert and delete operate on disjoint key sets, as required for
   [data-modifying CTEs](https://www.postgresql.org/docs/17/queries-with.html#QUERIES-WITH-MODIFYING).
3. Ordinary collector synchronization and CLI `--apply --incremental` omit the
   destination manifest. Full apply and `--verify` retain it; the lower-level API
   default remains compatible. `{}` means unobserved, not empty or verified.
4. A pre-existing SEACE pgTAP assertion now supplies an explicit description so it
   selects the schema-qualified `has_column` overload. No SEACE product behavior changes.

## Validation and measurements

The synthetic local benchmark uses 800 snapshots, 32,000 wide offers, 800 distinct
flights, and the observed 2184 kB `work_mem`. It warms both functions, interleaves
three samples of each, and compares every month/flight result with the previously
deployed implementation. It rolls back all synthetic data and helper functions.

| Median, repeated unchanged refresh |  Previous | Optimized |
| ---------------------------------- | --------: | --------: |
| Temporary blocks written           |    16,010 |     4,222 |
| Temporary blocks read              |    15,238 |     3,460 |
| WAL bytes                          | 1,820,502 |    90,733 |
| Elapsed time (ms)                  |   344.341 |   265.982 |

This fixture reduced temporary writes by **73.6%** and unchanged-refresh WAL by
**95.0%**. Timing varied with local load; do not interpret these percentages as a
production latency or total Disk IO Budget guarantee. Changed-data refreshes must
still write changed rows. The benchmark records elapsed time as well as I/O.

Run the opt-in benchmark on an isolated migrated PostgreSQL 17 database:

```sh
psql -X -v ON_ERROR_STOP=1 -f supabase/benchmarks/airfare_projection_io.sql
```

The local SQL suite uses the Supabase PostgreSQL image, pgTAP, and minimal Auth and
Realtime interfaces (not the running Auth/Realtime services). All 24 files pass:
662 pgTAP assertions plus the manifest catalog check. The new tests cover equal
timestamps/positions, duplicate offers, price reversion, unpriced sightings,
original JSON preservation, selective physical updates, and obsolete-row deletion.
The existing suite covers confirmed-empty, recovery, errors, RLS and dirty-month isolation.

Python validation with the repository's pinned requirements: 1,485 passed, 28
skipped, six existing FastAPI/Starlette deprecation warnings. Ruff lint/format and
mypy pass (96 source files). Changed Markdown passes Prettier; `git diff --check`
passes. The independent review found no blocking issues; both requested extra
ordering/selective-write cases were added. No frontend code changed.

## Rollout and follow-up

After review, apply the single forward migration and deploy the pinned Pi release.
Both changes are backward compatible and can be rolled out independently. The
deployment's existing acknowledgement invalidation can cause one conservative
baseline replay; do not remove it to make the rollout appear cheaper.

Observe at least two scheduled cycles, then compare an equivalent 24-hour period:
Disk IO Budget remaining, per-query temporary-block deltas per call, import durations,
failures, dirty backlog, and fresh/confirmed-empty UI results. Do not reset shared
statistics. The warning's exact hourly budget and CPU/swap history were not obtained
by this SQL review; inspect Supabase Observability before claiming the alert is resolved.
See [Supabase's disk I/O guidance](https://supabase.com/kb/troubleshooting/exhaust-disk-io).

Potential later improvements, deliberately outside this measured change:

- Replica-bound metadata acknowledgements for airports/watch recovery documents,
  with pending-before-write crash protection and deployment invalidation.
- Separate check-only availability/health updates from historical offer recomputation,
  preserving error-after-confirmation and no-offers recovery semantics.
- Reuse whole-pair metadata across dirty months, and review operational import-run
  retention separately from the durable fare archive.

The initial review made no production changes. The separately authorized November 7
rollout applied the migration and deployed the collector. No archive deletion,
collection slowdown, global memory increase, or compute purchase was performed.
