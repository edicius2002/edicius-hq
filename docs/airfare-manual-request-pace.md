# Manual Airfare request pace

The Pi worker for owner-initiated `airfare-route` requests starts Google requests at least **0.05 seconds** apart and allows up to **16** in flight. It still uses the shared Airfare process lock, the daily request ledger, the canonical Pi archive, and the normal replica sync. Scheduled collection and the existing board/calendar UI jobs retain their 3-second default and sequential board collection.

The change follows a bounded Pi probe on 2026-10-20 using the same 24 previously covered SCL→HND/NRT departure dates in each setting. The temporary collector copy used the parallel algorithm now enabled for 16 slots in this branch. Each setting produced 24 HTTP 200 responses and 24 successful canonical checks:

| Start gap / slots | Observed peak | Minimum start gap | Collection time |
| ----------------- | ------------: | ----------------: | --------------: |
| 0.125 s / 8       |             8 |          0.1251 s |         4.344 s |
| 0.075 s / 12      |            12 |          0.0748 s |         2.778 s |
| 0.05 s / 16       |            16 |          0.0502 s |         2.424 s |

All 72 checks were recorded locally and the single final sync reported `complete` in 69.937 seconds. The sync included pending records from before this probe. No 403, 429, or unreadable result occurred in the probe. The same dates were fetched three times, so caching may have helped; this short run does not establish sustained provider tolerance. The scheduled pass had a separate, pre-existing `parse-drift` failure on SCL departures at the September 2027 horizon edge; those dates were excluded from this probe.

The new constants are in `airfare_request_worker.py`. Its pass record stores the 0.05-second gap, and `fare_collector.collect` accepts up to 16 tasks while retaining a default of one. Deployment of the updated Pi service is separate from this code change.
