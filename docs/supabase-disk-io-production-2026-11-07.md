# Production disk I/O measurement — November 7, 2026

Project: `edicius-hq` (`abndifkxpfppmllgxfnu`). Release:
`d2f8a9847be84a2df3308a21969ac7546f388432`, branch `fix/supabase-disk-io`.
The owner explicitly authorized deployment and observation of normal production cycles.

## Rollout

- The Supabase CLI dry run identified exactly one pending migration,
  `20261106000000_airfare_projection_io.sql`. It was applied successfully; the
  production function definition was checked afterward.
- The predeployment function definition was saved locally for recovery. Shared
  PostgreSQL statistics were not reset, and no benchmark or synthetic traffic was
  run against production.
- At 11:23:52 UTC (06:23:52 Lima), the optimized SQL was installed, no refresh was
  active, and there were no dirty routes. This is the counter baseline below.
- At 11:31:48 UTC, SSH verified that `/opt/edicius-hq/current` pointed to the exact
  release above. Both Airfare timers and the request worker were active.
- The first scheduled collection started at 11:30:08 UTC. The deployment deliberately
  invalidates baseline acknowledgements, so its initial replay is a rollout cost;
  it must not be presented as steady-state import latency.

## Predeployment reference

These are counter differences between November 6 at 16:24:03.819135 UTC and
November 7 at 11:20:04.182705 UTC: 18.9334 hours of natural traffic. The counters
had not advanced at the 11:23:52 postmigration baseline.

| Statement                   | Calls | Temporary writes (GiB) | Temporary reads (GiB) | Mean execution (s/call) |
| --------------------------- | ----: | ---------------------: | --------------------: | ----------------------: |
| Route projection refresh    |   455 |                37.7991 |               42.3482 |                  8.4053 |
| Global destination manifest |   105 |                 5.1047 |                5.0878 |                 19.4083 |

Together these statements wrote 42.9038 GiB of temporary data during the reference
interval. This is I/O volume, not database storage growth or the provider's Disk IO
Budget percentage.

Statement IDs, retained as strings to avoid integer rounding:

- Route refresh: `7851781438656969977`.
- Manifest: `5316060307912541693`.

At 11:23:52 UTC, route counters were 10,522 calls, 220,203,216 temporary blocks
written, 235,393,423 read, 77,269,403.8859104 ms execution and 13,371,610,229 WAL
bytes. Manifest counters were 4,267 calls, 9,757,561 temporary blocks written,
9,716,469 read, 35,031,093.779505 ms execution and 35,391,039 WAL bytes.
Each PostgreSQL block is 8 KiB. Statistics reset: September 15 at 15:06:27.064765 UTC.

## Initial replay, reported separately

The first import ran from 11:30:56.141499 to 11:37:57.195621 UTC and completed in
421.05 seconds. The collection service exited successfully at 11:37:59. Its log
reported seven checks, two changed results, and zero provider failures.

AQP–LIM hit one statement timeout (`SQLSTATE 57014`) on finalization attempt 1.
The existing automatic retry recovered without intervention. At 11:38:38.185806
UTC, dirty routes, dirty months, active refreshes and waiting locks were all zero.
The 11:37 reconciliation service deferred with exit 75 because collection still
held the process lock; systemd correctly classified this as success.

Relative to the 11:23:52 baseline, successful route statements added 27 calls,
1.0270 GiB temporary writes, 1.0010 GiB temporary reads and 11,347,449 WAL bytes.
Their mean execution time was 5.1737 seconds and temporary writes averaged
38.9505 MiB/call. These counters exclude the canceled statement's execution cost
and do not support a claim about total rollout I/O savings.

The manifest counter remained exactly 4,267 calls. The completed import stored
an omitted destination manifest, confirming that the deployed collector took the
new incremental path. No manifest was calculated for that import.

At the 11:38:38 reference for subsequent traffic, route counters were 10,549 calls,
220,337,829 temporary blocks written, 235,524,629 read, 77,409,094.4409534 ms execution
and 13,382,957,678 WAL bytes. Database-wide temporary bytes were 1,707,616,148,991
with zero deadlocks (database statistics reset August 25 at 20:33:23.891825 UTC).

## First ordinary cycle after replay

The next scheduled collection started at 11:45:14 UTC. Its log reported 37 checks,
seven changed results and zero provider failures. Its incremental import ran from
11:46:02.746037 to 11:46:25.791742 UTC, completing in **23.05 seconds** with its
destination manifest omitted. There were no timeout/retry messages in this cycle.

The snapshot at 11:47:03.619756 UTC showed zero dirty routes, dirty months, active
refreshes and waiting locks. Both observed imports were complete, none failed.
The newest projection was built at 11:46:24.620828 UTC.

| Route refresh metric            | Predeployment reference | First ordinary cycle |
| ------------------------------- | ----------------------: | -------------------: |
| Completed calls                 |                     455 |                    4 |
| Temporary writes per call (MiB) |                 85.0689 |              10.7051 |
| Mean execution (seconds)        |                  8.4053 |               4.6403 |

This is an observed **87.4% lower temporary-write volume per completed call** and
**44.8% lower mean execution time**. Four calls from one ordinary cycle are a small
sample with a different route/month mix; these are preliminary observations, not
an established steady-state percentage or an estimate of total Disk IO Budget savings.

Compared with the post-replay reference, the four calls wrote 5,481 temporary
blocks (42.8203 MiB), read 5,257 blocks (41.0703 MiB), generated 574,376 WAL bytes
and accumulated 18,561.295855 ms execution. The final cumulative route counters
were 10,553 calls, 220,343,310 temporary blocks written, 235,529,886 read,
77,427,655.7368084 ms execution and 13,383,532,054 WAL bytes.

The manifest counter remained at 4,267 calls throughout both observed cycles:
**zero new global manifest executions**. Previously each such call averaged
49.7827 MiB temporary writes and 19.4083 seconds during the reference interval.

Database-wide temporary bytes reached 1,707,692,791,973 at 11:47:03 UTC. This includes
other database work and is intentionally not equated to the route statement delta.
The statistics reset timestamps remained unchanged. Observations and raw counter
snapshots were retained locally under ignored `.local-data/production-io-*.json`.

Production remains on code release `d2f8a98`; the subsequent report commit only
updates documentation. A longer comparable observation window is still required
to establish sustained savings and verify that the provider's warning clears.

## Interpretation limits

The before/after windows use natural traffic with different route/month mixes and
cache conditions; they are observational, not a same-input controlled benchmark.
[`pg_stat_statements`](https://www.postgresql.org/docs/17/pgstatstatements.html)
updates execution statistics only for successful operations. These counters omit
the canceled statement's execution cost, so they are not a complete I/O accounting
of a rollout with timeouts.
Deployment replay should be reported separately from ordinary incremental runs.
The earlier synthetic benchmark is documented in the [review](supabase-disk-io-review.md).

A reduction in temporary blocks does not directly establish a proportional change
in total disk I/O, CPU, or Supabase's remaining burst budget. The original warning
cannot be declared resolved without the provider's budget metric and a comparable
longer observation window. Supabase exposes that metric under
[Observability / Database Health](https://supabase.com/kb/troubleshooting/exhaust-disk-io).

## Repeating the counter measurement

Run this read-only SQL through `supabase db query --linked --project-ref
abndifkxpfppmllgxfnu --output json --file <sql-file>`. Keep both snapshots and
check that counters and their reset timestamp are continuous. Do not reset them.

```sql
select now() as observed_at,
  (select stats_reset from extensions.pg_stat_statements_info) as stats_reset,
  queryid::text, calls, total_exec_time,
  temp_blks_read, temp_blks_written, wal_bytes
from extensions.pg_stat_statements
where queryid in (5316060307912541693, 7851781438656969977);
```

For each statement, subtract the initial counters from the final counters.
Temporary MiB/call = `delta(temp_blks_written) / 128 / delta(calls)`;
mean seconds/call = `delta(total_exec_time) / 1000 / delta(calls)`.
A zero-call interval has no per-call measurement. Keep rollout replay and normal
cycles separate, and inspect completed/failed import records and dirty-route
backlog alongside these counters.
