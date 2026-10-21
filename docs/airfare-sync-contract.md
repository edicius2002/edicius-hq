# Airfare synchronization contract

The local archive remains authoritative. Synchronization does not delete or
rewrite source journals. The watch document remains a local KV value replicated
for recovery.

Incremental sync checkpoints each newline-terminated journal after a confirmed
upsert, including baseline journals. An unchanged baseline file is not uploaded
again. Baseline merges atomically replace their route file; the recorded inode
and prefix digest detect that replacement and replay the changed route from the
beginning. A failed batch resumes after the last confirmed line, while a full
sync deliberately replays every file.

Manual route requests publish only the validated route they collected. Their
import-run source manifest declares that route scope and does not claim a scan
of other routes or global JSON documents. They refresh that route's dirty
projection before reporting success. The destination manifest is not collected
on the manual critical path; an empty `destination_manifest` in such a run
means unobserved, not an empty destination or a verified match. Explicit
`verify` still compares a frozen full source scan against the destination.

Other routes retain their source cursors and database dirty markers. A separate
periodic global incremental sync recovers their backlog even when a scheduled
collection pass is unsuccessful. A manual request therefore reports only its
own route as synchronized.

## Identity and source positions

Append-only records use SHA-256 of kind, normalized route, and canonical original
JSON. Byte-equivalent canonical source records collapse to one logical record.
Reports retain physical valid and skipped counts alongside logical counts.

Snapshots and calendar captures retain the positive, one-based physical JSONL
line number of the final occurrence of each content identity. Blank and invalid
lines occupy physical positions. An unterminated trailing line is not imported
or acknowledged.

Source positions are mutable replay metadata, not database uniqueness keys. A
valid source replacement may shift or swap positions across separately committed
batches. Old and new metadata can temporarily overlap until replay completes;
timestamp, source line, and record ID still define deterministic read ordering.
The importer rejects actually ambiguous normalized route/timestamp/line positions
in its complete source scan before writing. Positive source-line constraints and
content-ID primary keys remain enforced by PostgreSQL.

Baseline points use `(origin, destination, flight_date, price_date)` as their
upsert conflict key. A provider revision replaces that point's payload and
content ID. The local baseline writer preserves the union of natural keys;
arbitrary source-key deletion is outside the no-delete synchronization contract
and appears as destination extras during verification.

The baseline acknowledgement checkpoint is bound to the replica identity and
the baseline cursors of every alias of its route. A cursor written by an older
release invalidates those acknowledgements. Deployment also invalidates the
checkpoints on every release transition, including rollback, because an older
release could have changed the remote row and crashed before writing a cursor.
The next sync then replays the baseline once to restore certainty.

## Cross-process exclusion

Every mutating synchronization takes an operating-system advisory lock before
scanning the source and holds it through remote uploads and cursor acknowledgements.
The API and migration CLI therefore cannot publish overlapping source snapshots;
a waiting process scans only after the prior process finishes. The kernel releases
the lock if its holder exits, so a crashed synchronization does not leave a stale
lock that requires manual cleanup. The lock file lives under the shared archive's
`fares/sync` directory, which remains shared across services with private `/tmp`
namespaces.

## Verification and read comparison

Each dataset digest hashes its sorted unique record IDs joined by LF, without a
trailing LF. The manifest RPC separately returns sorted nonempty route groups
with `dataset`, `route`, `count`, and `digest`.

Read comparison uses logical local equivalence: source content identities are
deduplicated before domain conversion, retaining final physical occurrence order.
Health counts use unique check identities. Different-content observations,
ordering changes, and explicit null versus zero remain observable differences.
Physical source counts remain visible in the comparison report's source manifest.

## Report destinations

Report paths are checked before any operation can write. Both lexical and fully
resolved authoritative roots are protected, including consumed source files
behind nested directory aliases. Existing report targets are also compared by
filesystem identity against every authoritative file the scanner can consume,
so hardlinks cannot overwrite journals or the watch document indirectly.

## Finalization retries and deadlines

After acknowledged source batches, global finalization drains dirty route
projections, reads the full destination manifest and upserts the same import-run
ID as complete. Manual finalization refreshes only its requested route and
omits the global manifest read.
A transient remote/network failure retries this phase at most twice, after 1 and
2 seconds. It does not recollect departures or replay acknowledged source uploads.
Permanent rejections fail immediately; exhaustion still reports a failed sync.
Errors record the sanitized HTTP status/SQLSTATE, never the response body or key.

Both projection refresh and manifest RPCs have 30-second database deadlines and
35-second client deadlines. The manifest override is service-role-only and must
be followed by a PostgREST schema-cache reload; no global timeout is increased.
An explicit manual partial pass publishes any successful departures, even if
failures are the majority, while retaining the failed-day counts. Scheduled
passes continue to require their existing clean-pass conditions.
