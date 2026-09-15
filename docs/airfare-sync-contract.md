# Airfare synchronization contract

The local archive remains authoritative. Synchronization does not delete or
rewrite source journals. The watch document remains a local KV value replicated
for recovery.

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
