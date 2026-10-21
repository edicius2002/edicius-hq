# Airfare manual Syncing measurement — 2026-10-20

The Pi service logs for eight completed manual requests on 2026-10-20 showed
Syncing durations of 41.642–65.915 seconds, with a median of 55.189 seconds.
These timings were read from `edicius-airfare-requests.service`; no production
fetch or write was triggered for the measurement.

| Interval inferred from service log boundaries                       |  Median | Observed range |
| ------------------------------------------------------------------- | ------: | -------------: |
| Last progress response to first `airfare_import_runs` POST response |  26.3 s |    25.5–28.0 s |
| Upload/preparation through dirty-route list response                | 12.45 s |     1.5–18.8 s |
| Dirty projection refresh                                            |   0.7 s |     0.3–29.2 s |
| Last projection response to global manifest response                |  8.95 s |     6.7–14.0 s |

The first interval includes process-lock wait, the whole source scan and
manifest construction, plus the first HTTP request. It does **not** isolate
CPU time spent scanning. Baseline uploads ranged from 0 to 47 batches. Earlier
requests also had projection and manifest HTTP 500 responses around the 30 s
mark. A late manifest failure could mark an otherwise uploaded request failed.

The deployed Pi commit was `f2b6481`; the local checkout was `98580af` and
had diverged. Both versions scan and parse every journal before consulting
incremental cursors. The deployed version additionally retries finalization.

## Local synthetic scan check

On the Windows development machine, 12 baseline journals with 3,000 valid
rows each were generated in a temporary directory. `_collect()` took 0.963 s
on the first global scan and 0.642 s warmed; `_collect(route_scope="A00-B00")`
took 0.080 s and 0.085 s for the one-route scan. This demonstrates that the
new path's parse cost scales with the selected route on this synthetic data.
It is **not** a Pi latency result and should not be subtracted from the real
55.189 s median.

## Deployment measurement to complete

After the optimized release is deployed, compare at least eight completed
manual requests using the same log boundaries. Record route, source journal
bytes/rows, baseline rows actually uploaded, projection duration, finalization
retries, and `sync_ms`. Report median, range, and failed requests separately.
The optimized sync logs lock wait, scan time/bytes, upload time/row counts,
projection time, manifest time, and final-write time by run ID. These fields
will separate parser work from lock wait and transport in the first interval.

The manual path still parses the selected route's complete history; it avoids
the unrelated routes and global JSON documents. Every release transition
invalidates baseline acknowledgements for correctness across rollback. Record
the first post-deployment replay separately from steady-state requests.
