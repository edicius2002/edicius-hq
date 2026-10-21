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

## Pi measurement after deployment — 2026-10-21

The deployed Pi release was `883db1e`. Eight sequential `LIM-AQP`, February
2027 manual requests completed without failures. A ninth request tested the
larger `AQP-LIM` archive. Each request collected 28 departures, for 252 upstream
requests in total. The measurement inserted owner-scoped queue rows using the
Pi's existing service credential and let the deployed manual worker process
them. It exercised collection, archive sync, progress and completion, but did
not measure browser rendering or the owner-authenticated enqueue RPC.

| Route     | Samples | Database `syncing` to `complete` |                Worker `syncMs` |               Queue to complete |
| --------- | ------: | -------------------------------: | -----------------------------: | ------------------------------: |
| `LIM-AQP` |       8 |   2.600 s median (2.202–9.905 s) | 2.463 s median (2.072–9.611 s) | 6.195 s median (5.961–15.491 s) |
| `AQP-LIM` |       1 |                         22.308 s |                       21.887 s |                        26.724 s |

The database interval uses the `updated_at` of the first observed `syncing`
state and the terminal `completed_at`; `syncMs` is the Pi's monotonic timer
around the sync call. The earlier 55.189 s median was reconstructed from
service-log boundaries on a different mix of routes, so the 2.600 s median is
strong evidence of an improvement but not a route-matched controlled
comparison. No post-deployment request failed or required a finalization
retry. The browser's Realtime/poll delay remains outside these measurements.

For `LIM-AQP`, the route-scoped scan parsed five journals totaling
11.43–11.45 MB and took 1.187–1.233 s. Its first request uploaded 1,730
baseline rows and had a 9.611 s sync; all later requests uploaded zero
baseline rows. The eight projection refreshes took 0.221–2.176 s. Every
manual manifest log had `collected=False` and `manifest_ms=0`; the sync lock
wait was 0 ms in all nine requests.

The `AQP-LIM` request scanned 128.65 MB in 13.004 s and refreshed its
projection in 7.183 s. This is the remaining large-route cost: the manual
path still parses its selected route's complete history. It avoids unrelated
routes and global JSON documents. The subsequent independent global timer
completed successfully in 39.073 s, separate from manual Syncing.
