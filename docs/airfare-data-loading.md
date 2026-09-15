# Airfare data loading

Review from September 11, 2026, limited to **How the price moved** and **Flights seen**.

## Verified findings

- `useFareHistory` and `useFareCalendar` query in parallel. History includes snapshots for the complete route; the month limits the baseline and collection statistics. The calendar returns the combined horizon.
- The queries inherited 30 seconds of freshness, one retry, and no refresh on focus. They had no periodic refresh. An empty response or an error after the retry could persist while the page remained open.
- Invalidations and the local collection stream did not cover writes from another session or the scheduled collector.
- `AnalysisPanel` received calendar loading and error states but not history states. `FlightTable` received an empty array both when no data existed and when data had not arrived or the query had failed. This allowed it to report no flights before confirming the read.

Regression tests reproduced queries that did not incorporate a later response containing data and did not recover from an error without reloading. They also reproduced the empty-table message during loading.

## Changes

- Mounted, visible queries read the archive again every 60 seconds. Transient failures are queried again 15 seconds after entering the error state. The existing immediate retry remains. HTTP 408 and 429 errors permit recovery; other 4xx responses stop periodic querying.
- Regaining focus or connectivity revalidates stale queries. Local collection invalidations continue to refresh immediately.
- A response remains fresh for 60 seconds and is retained for up to 30 minutes after losing all observers. Reopening a recent route displays the cache without another request; if it is already stale, it remains visible while it refreshes.
- Charts and the table distinguish loading, error, and confirmed absence of data. They allow history to be retried without reloading the page and retain available data when a refresh fails.
- History waits for both a route and a month before querying. Cancellation when changing routes remains intact.

These queries only read stored data: they do not start Google Flights searches or new collections. Periodic refresh increases server reads while the page is visible, normally by two requests per minute in addition to invalidations and recovery attempts.

## Performance and measurement limits

The reopen-at-35-seconds test went from two requests to one, with data available on the second opening's first render. This verifies an improvement to repeated navigation; it does not measure a reduction in first-load latency.

The initial file search was incomplete: it inspected `.local-data/fares`, while the real data is in `services/api/.local-data/fares`. The later measurement uses those files and is detailed below.

### Measurement with real data

Each endpoint was read 15 times for each of the seven stored routes: 105 history reads and 105 calendar reads. No responses were empty and the snapshot/price counts for each route remained stable. The first stored month for each route was used. The operating system's disk cache was not cleared.

| Route   | History read and JSON, median | Calendar read and JSON, median | Page with prepared responses, median | Switch to How the price moved, median |
| ------- | ----------------------------: | -----------------------------: | -----------------------------------: | ------------------------------------: |
| ARI–SCL |                      94.80 ms |                       10.26 ms |                             450.3 ms |                               79.8 ms |
| SCL–ARI |                     106.79 ms |                       10.35 ms |                             423.5 ms |                               64.2 ms |
| SCL–AEP |                     200.94 ms |                       10.03 ms |                             423.3 ms |                               62.6 ms |
| AEP–SCL |                     234.74 ms |                       10.48 ms |                             442.6 ms |                               64.7 ms |
| LIM–MAD |                     269.98 ms |                        8.24 ms |                             465.2 ms |                               76.5 ms |
| MAD–LIM |                     307.02 ms |                        9.67 ms |                             463.3 ms |                               62.3 ms |
| AQP–LIM |                   1,968.55 ms |                       10.21 ms |                             660.5 ms |                               64.4 ms |

**The columns measure separate stages, not an end-to-end production session.** Read and JSON invokes the real endpoint functions and Pydantic serialization without network, authentication, or compression. The active API returned 401 to an unauthenticated request; that rejection was not included in the data measurement.

For the browser measurement, the real `AirfarePage` was compiled in production mode and served over local HTTP with saved real responses compressed with gzip. Each route was opened five times, each in a new browser context: 35 openings in total. Chromium ran without GPU acceleration at 1440 × 1000 with reduced motion. Each run verified the route and exact number of snapshots received, the appearance of table rows, and the absence of JavaScript errors. All 35 openings passed.

Page time runs from navigation until the table is available and two animation frames have painted. The chart switch includes the automated click and two animation frames. It excludes authentication, the outer application shell, server-side JSON construction, and any WAN connection. It is a local measurement of transfer, decompression, JavaScript, and rendering with prepared responses. The medians must not be added together as though they were an observed end-to-end measurement.

### Dominant cost and next optimization

**AQP–LIM has the greatest cost:** a 21,022,534-byte file containing 4,368 snapshots and 87,695 offers. Its history response is 19,392,203 bytes uncompressed and 885,720 bytes with gzip. Of the 1,968.55 ms median, response construction takes approximately 1,796.69 ms and serialization takes 152.46 ms; stage medians do not necessarily add up to the total median. The maximum observed total was 2,697.72 ms. Chromium's median JSON parse time was 55.9 ms.

For the other routes, history parsing took 3–11.6 ms. Calendars were approximately 28–29 KB uncompressed and took 8–11 ms to construct and serialize. These observations place the priority on reading and constructing history, ahead of the chart or calendar.

The next optimization supported by these measurements is to reuse the file read and decoding while its identity, size, and modification time remain unchanged, invalidating it after writes. Route snapshots could then be separated from month-specific data to avoid transferring the complete history again when changing months. Snapshots cannot simply be limited to the selected month: **Flights seen** uses all watched months and the price reference uses the complete route.

The intermittent data loss was not reproduced under the measured conditions. The observed maximum leaves less margin within the five-second timeout but does not prove that reported incidents were timeouts. The session's real network, the complete HTTP server cost under concurrency, and concurrent collector writes remain unmeasured.

Detailed historical results: [airfare-measurements.json](airfare-measurements.json). The JSON contains metrics and references to temporary payloads; it does not contain the complete offers. Its temporary input snapshot was not retained, so the exact historical digests cannot be reproduced and this preserved artifact must not be overwritten. To rerun the current non-destructive methodology on a new frozen snapshot, follow [Airfare history cache validation](airfare-optimization-results.md#rerunning-the-methodology); it writes separate baseline, optimized, and comparison reports from detached worktrees.

The scripts do not start collectors or write to the original archive. The temporary server listens only on loopback and implements no writes; it is closed when the run finishes. Temporary payloads are stored at the path recorded in the JSON.

Recovery cannot guarantee data while the server remains unreachable or a file remains corrupt. Server readers can convert parsing failures into empty arrays; the new periodic queries allow recovery if a later read succeeds but cannot distinguish that response from a legitimately empty file. This was not proven to be the cause of the reported incidents.

## Reproducible validation

```powershell
npm run test -w web -- src/features/airfare
npm run typecheck
```

The regressions cover external updates, recovery from network and transient HTTP failures, cache reuse, data retention after a failure, visible loading and error states, and a slow response for a previous route that must not replace the current route.
