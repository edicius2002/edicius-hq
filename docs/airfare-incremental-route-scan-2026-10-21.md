# Incremental manual Airfare route scan — 2026-10-21

## Cause and change

The manual route path in PR #284 restricted the scan to the selected route, but
`_collect(route_scope=...)` still read and parsed every historical line before
consulting upload cursors. Its full-prefix cursor hash also scaled with journal
size. The Pi's AQP-LIM request read 128,653,873 bytes in 13.004 seconds, then
spent 7.183 seconds refreshing its projection. The latter is a separate database
cost and this change does not affect it.

Manual Syncing now keeps a derived index under `fares/sync/route-index/`. It
stores the route's complete content IDs, physical and skipped counts, baseline
natural keys, snapshot/calendar positions, and each journal's completed-line
offset. The index is checksum protected and written atomically only after a
successful sync. Subsequent manual requests verify the cached cursors, file
identity, size, modification time when size is unchanged, and a 4 KiB boundary
window. They read and parse only bytes after the indexed newline, including any
previously incomplete line. The full route manifest is recomputed from indexed
IDs plus the new IDs; run records and published rows retain their prior shape.
The fast cursor also carries a rolling CRC32 of the acknowledged prefix. Manual
Syncing extends it from new bytes; the global full scan recalculates it over the
whole prefix before trusting that cursor, retaining its historical-change
detection.

The route falls back to a complete scan if the index is absent or invalid, a
journal is replaced or truncated, an alias set changes, cursors differ, or a
baseline ACK is invalid. Failed remote writes do not advance the index; retry
replays the unconfirmed portion. Old releases reject the new cursor format and
replay conservatively; a rollback that rewrites a cursor forces index rebuilding
on the next manual sync. Global `apply()` and `scan()` still scan the full archive.
The local journals remain the write authority; the index is disposable.

## Reproducible local benchmark

`PYTHONPATH=services/api python scripts/benchmark_airfare_manual_scan.py --mebibytes 120`
generates a temporary 120 MiB baseline journal, times the old full route
collection, builds an index, appends 28 valid rows, and times incremental
collection plus the complete manifest. It makes no provider or network calls.
Python 3.12 on the Windows development machine produced:

| Path        | Journal bytes read | Rows parsed | Scan and manifest time |
| ----------- | -----------------: | ----------: | ---------------------: |
| Full        |        125,829,166 |     954,093 |               16.241 s |
| Incremental |             11,888 |          28 |                1.885 s |

The incremental byte count includes two 4 KiB boundary reads and 3,696 bytes
of appended JSONL. It excludes reading the derived index; the 1.885 seconds
includes parsing that index and recomputing the exact sorted-ID digest. The
initial index build is a one-time full-scan cost. These are local synthetic
measurements, not a Pi end-to-end Syncing result. Network uploads and the
7.183-second AQP-LIM projection remain outside this benchmark.

The fast path assumes a growing file with a stable identity is append-only,
as the journal writer's contract requires. An arbitrary in-place edit far
before the boundary followed by an append cannot be proven absent during the
manual fast path without reading the entire prefix. File replacement,
truncation, same-size edits, and cursor/ACK changes trigger a full scan. The
periodic global scan recalculates the rolling checksum and continues to read
and reconcile the complete archive. CRC32 is a change detector, not a
cryptographic integrity proof against deliberate collisions.
