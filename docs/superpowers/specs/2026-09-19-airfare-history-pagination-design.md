# Lossless Airfare history pagination

Date: 2026-09-19

Status: written specification approved by the user on 2026-09-19; implementation
plan and execution method awaiting review.

Baseline: `6d9173888fe9cd071c5e557bbacc79ccf9868d55`, PR #203.

## Intent and success

The owner must be able to open a watched Airfare route containing multiple months
without the hosted query timing out, losing observations, changing their order,
or displaying an incomplete response as a complete historical record.

Replace the single large history transfer with bounded, version-checked pages.
Web and Python readers assemble the same complete history response behind their
existing caller-facing interfaces. Existing RPCs remain available for compatibility.
This is a transport/read-path change, not a change to the Airfare archive, collection
authority, domain calculations, or retention policy.

Success requires exact read parity AND the real multi-month screen-shaped canary.
Neither a fast EXPLAIN nor passing single-month comparisons is sufficient.

## Evidence and constraints

The deployed SQL-array optimization in `6d91738` removed the tested single-month
failure. All 22 monthly/calendar comparisons across seven watched routes passed.
However, AQP-LIM with departure `2026-11` and snapshot months `2026-11,2026-12`
still produced HTTP 500 / SQLSTATE 57014. The hosted API statement deadline is 8s.
See [the local measured result](../../pi-collectors-evidence/2026-09-19-history-json-result.md)
(intentionally untracked evidence, available in this worktree).

[ADR 0004](../../ADRs/0004-pi-collectors-supabase-data-plane.md) remains authoritative:
the Pi owns the archive, Supabase is its indexed replica, and browser reads are
owner-gated. This design retains the remaining decisions in ADR 0003. In particular,
the retained local Python fallback is distinct from replication and from browser
access. The older watch-authority wording in the synchronization contract is
superseded by ADR 0004, not revived here.

Source positions can move during a replay, and baseline natural-key upserts can
replace payloads and content IDs. Pagination cannot assume every write is a strictly
later append. See [the synchronization contract](../../airfare-sync-contract.md).

No merge, Task 12, deletion, downsampling, timeout increase, new credentials,
collector activation, or observation-window completion is authorized by this spec.

## Alternatives and decision

1. **Cursor pagination with revision validation — selected.** Bounds each response,
   retains full wire payloads, and detects concurrent inserts and replacements.
   Costs additional requests and a small amount of database revision metadata.
2. **One request per month.** Does not bound a growing month's payload and cannot
   reproduce the original cross-month ordering from payload timestamps alone when
   observations tie. It would also duplicate summary work.
3. **Derived summaries or retained server-side result snapshots.** Summaries alone
   cannot preserve the complete response. Retained snapshots would add large storage,
   lifecycle and cleanup concerns. Neither is needed for this change.

Offset pagination, pruning, and increasing the database deadline are not substitutes
for the selected design.

## Modules and unchanged external interface

| Module                         | Responsibility                                                                      |
| ------------------------------ | ----------------------------------------------------------------------------------- |
| PostgreSQL history readers     | Filter, order and bound pages; enforce revision consistency and access rules        |
| Web Airfare reader             | Fetch and validate pages, honor cancellation, assemble one `FareHistoryResponse`    |
| Python Airfare reader          | Same protocol; return the legacy wire document for domain conversion and CLI parity |
| Existing screen/domain callers | Continue consuming complete history; no cursor or revision knowledge                |

The web implementation belongs behind
`apps/web/src/features/airfare/data/supabaseAirfare.ts`; its shared facade and
`useFareHistory` retain their existing route/month query keys and response interface.
Pagination helpers can be private files in that module, not logic in chart components.
The existing `AbortSignal` must reach every active request; currently the lower-level
history reader does not forward it.

The Python implementation belongs behind the Supabase Airfare reader in
`services/api/app/services/airfare_supabase.py` or a focused internal helper.
`AirfareData._remote_history` and `scripts/fares-supabase.py` must use the same assembled
reader, rather than independently implementing pagination. Domain validation and
local fallback remain in `AirfareData`. Calendar and airport-search reads are unchanged.

## Database protocol

Add service-role-only `read_airfare_history_meta` and `read_airfare_history_page`,
plus matching owner-gated `read_owner_airfare_history_meta` and
`read_owner_airfare_history_page`. Do not replace or remove the legacy history RPCs.

All calls receive the existing six history filters. Metadata additionally accepts
an optional expected revision; page calls require a revision, dataset discriminator
(`snapshots` or `baseline`), optional cursor, and page size. New readers are STABLE
with an empty search path. Core readers use SECURITY INVOKER; owner wrappers follow
the existing SECURITY DEFINER allow-list check on every request.

### Filter semantics

- Preserve origin/destination filtering and all currently valid filter inputs.
- Preserve `NULL` snapshot months as unbounded whole-route history and `[]` as no
  snapshots. Deduplicate repeated months; do not replace one form with the other.
- Preserve inclusive lexicographic observation bounds using `captured_at_text`.
- Preserve the departure prefix for baseline and health, independently of the
  requested snapshot months. Empty strings retain their existing unbounded meaning.
- Preserve whole-pair reference calculation across all priced departures, including
  dates outside the selected months and observation bounds.
- Canonicalize only equivalent filters for a deterministic query key: empty/unset
  optional text filters, sorted unique month sets, and the exact route. Include the
  protocol version. Invalid month/cursor inputs fail explicitly, not as empty history.

### Metadata response

Return `protocolVersion: 1`, a decimal-string `revision`, a deterministic `queryKey`,
origin, destination, decimal-string snapshot and baseline counts, health, airports,
and pairReference. Counts are parsed exactly, not rounded through JavaScript Number.
Counts and summary values come from the same statement snapshot as the revision.
No snapshot or baseline payload arrays are materialized by this call. Health remains
scoped to the departure prefix; airports retain origin-first ordering.

Calling metadata with an expected revision validates that revision before returning
a summary. The clients use this for final validation as well as the initial read.
The query key binds pages to filters; it is not a credential or authorization token.

### Page response and cursors

Return the protocol version, query key, revision, dataset, `items`, and `nextCursor`.
Each item carries the original, unchanged `payload`, its `recordId`, and ordering
metadata. Strip the transport metadata only after assembly; never inject it into the
domain payload or its canonical content identity.

| Dataset   | Ascending order / exclusive continuation key |
| --------- | -------------------------------------------- |
| snapshots | `(captured_at_text, source_line, record_id)` |
| baseline  | `(flight_date, price_date, record_id)`       |

Use the same SQL comparison and ordering semantics as the existing RPC. No OFFSET,
timestamp-only cursor, client-side regrouping by month, or page-local deduplication
may replace this total ordering. Different records sharing a timestamp remain distinct.

A cursor is a versioned JSON object containing the query key, revision, dataset and
last returned ordering tuple. Revision and bigint source-line values are decimal
strings on the wire, avoiding JavaScript integer rounding. Validate types, positivity,
record-ID format and tuple shape before use. A cursor for a different filter,
revision or dataset is rejected. It is treated as untrusted input, never executable
SQL or authority to skip the owner check. A well-formed caller-chosen position grants
no access beyond that caller's normal filtered read.

Default page size is 100 rows; the server accepts 1–250. Bound the complete serialized
JSON page to 1 MiB, using a bounded candidate set of at most requested size plus one
and an ordered prefix that fits the byte budget, including envelope/cursor overhead.
Do not JSON-aggregate the entire history before limiting. One lookahead row establishes
whether continuation exists. If a row cannot fit in an otherwise empty page, return
`airfare_history_item_too_large`: never skip, truncate, split its payload, or loop
on an empty page. A terminal empty page is valid only when no rows remain.
Oversized-item errors use SQLSTATE `22023` and that fixed message. Apply the same
1 MiB bound to metadata responses; an oversized summary is an explicit failure,
not a reason to omit an airport payload or another summary field.

`nextCursor` is null exactly at dataset exhaustion; otherwise it identifies the last
emitted row and advances strictly. An exact multiple of the requested page size must
terminate correctly. Clients verify counts, duplicate identities, ordering progression,
revision and query binding; a malformed response is not successful partial history.

Indexes must support the route and continuation order without fetching discarded
payloads. Preserve the existing month-range indexes. Validate whole-route and bounded
month plans using actual execution plans before choosing any additional composite
index; index additions are additive and must be justified by those measurements.

## Consistency under synchronization

Add one private singleton history-revision row with a transactional bigint counter.
Statement-level triggers advance it for INSERT, UPDATE, DELETE and TRUNCATE on
`fare_snapshots`, `fare_baseline_points`, `fare_checks` and `fare_airports`. These are
all stored inputs to history payloads or summaries. Calendar captures, import-run
status and watch documents do not affect a fixed history query and do not advance it.

The global counter intentionally also invalidates unrelated-route changes and harmless
replays. This is conservative and simpler than a route/airport dependency graph. It
adds a serialized counter update to write statements; measure importer overhead and
concurrent-write behavior. Do not silently omit a mutation path to improve throughput.
An upsert may fire more than one trigger: monotonic change, not increment-by-exactly-one,
is the contract. A missing revision row is an error, never revision zero.

The counter update occurs in the same transaction as each data mutation. Rollback
rolls back both. This avoids using a sequence, timestamp watermark, max record ID or
import-run status as a substitute for committed data revision. PostgreSQL documents
the transaction relationship of triggers in its
[trigger overview](https://www.postgresql.org/docs/17/trigger-definition.html).

Each read validates the expected revision and reads its rows using the same calling
statement snapshot. STABLE functions provide that fixed snapshot for their internal
reads; see [PostgreSQL function volatility](https://www.postgresql.org/docs/17/xfunc-volatility.html).
If the revision changed, return SQLSTATE `40001` with the fixed message
`airfare_history_revision_changed` and no page payload. Do not return an empty page.

This does not retain a database transaction across HTTP requests or freeze collection.
It proves the assembled result belongs to one unchanged committed revision. A write
after the final validation may make that result older, just as after any completed
read; it does not make it inconsistent. A multi-batch replay can be observed between
committed batches, as with the existing RPC; the design does not promise an atomic
whole-import publication that the importer does not currently provide.

Enable RLS on the revision table. Grant service_role SELECT only and grant browser
roles no direct access. A narrowly scoped SECURITY DEFINER trigger function with an
empty search path can advance the counter; revoke direct execution from client roles.
Test real service-role upserts with these privileges. No other collector/table grants
or owner relationships change.

## Client lifecycle and failures

One logical history read performs these dependent stages:

1. Get metadata and bind query/revision/counts.
2. Fetch snapshot pages, then baseline pages, sequentially and in server order.
3. Validate terminal cursors, identity uniqueness and exact advertised counts.
4. Revalidate metadata at the same revision and verify unchanged summary/counts.
5. Return the existing complete response, atomically, without protocol fields.

A zero-count dataset requires no page calls; the final metadata validation still runs.
The initial metadata, all pages and final check use the same filters. Do not recompute
whole-pair reference or health from a partial page. Do not sort native JSON numbers
to reconstruct bigint cursor order; use exact ordering metadata representations.

On `40001` plus the exact revision-change message, discard the entire attempt and
restart from metadata. Allow two restarts (three attempts total), with cancelable
backoffs of 100ms and 250ms. No retries on invalid cursors, malformed responses,
permission failures or oversized items. Network/timeout failures abandon the partial
response. Disable automatic outer retries for this history query, so the application's
global query retry policy cannot multiply the three-attempt budget. Preserve scheduled
refetch/invalidation behavior; those are separate logical reads, not hidden retries.

The Python transport must recognize only the allow-listed revision-change code/message
before its generic HTTP-500 mapping, and expose a sanitized typed signal to the reader.
The web reader applies the same exact check. Do not print arbitrary server messages,
details, response bodies, headers or credentials. A different `40001` is not permission
to silently restart under this protocol. Cursor/protocol errors remain explicit failures.

Keep current per-request/database timeouts. Add a 60-second whole-operation budget,
including restarts and backoff, for each logical route/filter read. It limits a series
of requests; it does not raise any individual request deadline. Budget exhaustion is
an explicit unavailable/error result, never truncation. Abort/cancellation wins over
every retry and stops subsequent pages; honor it during fetch and backoff as well.

The web reader forwards the query's AbortSignal to Supabase and checks it before
publishing. Existing complete cached data can remain according to query policy, with
the failure represented honestly; no partially assembled cache value is published.

Python maps temporary network/deadline failure and exhausted revision churn to
`AirfareRemoteUnavailable`, preserving `AirfareData`'s logged local fallback.
Permission/protocol/oversized-item failures remain `AirfareRemoteRejected` rather
than being disguised as local or empty success. The parity CLI uses the assembled
remote reader directly and must not fall back to local data when checking parity.

## Validation and acceptance

Tests cross the real reader interfaces; deterministic fixture expectations are not
generated by the implementation under test. Shared wire fixtures keep Python and
TypeScript protocol handling aligned. Required cases include:

- Full JSON equivalence against the legacy RPC on fixed data: all fields, nested
  payloads, explicit null versus zero, empty results, numeric precision at the SQL
  level, baseline revisions, origin-first airports and whole-pair reference.
- Cross-page/cross-month timestamp ties, source-line ties resolved by record ID,
  duplicate month filters, inclusive lexical bounds, NULL versus empty months,
  arbitrary valid departure prefixes and exact-multiple final pages.
- Bigint cursor values beyond JavaScript's safe integer range; malformed, repeated,
  regressing, cross-query and cross-dataset cursors; missing/extra/duplicate rows.
- Row and byte bounds, a byte-trimmed page with progress, and an oversized individual
  record producing an explicit error without loss or an infinite loop.
- Real concurrent database sessions: insert behind a cursor, move source_line,
  replace a baseline, modify health or airport data, commit/rollback races and a write
  before final validation. Mixed revisions must restart, not produce mixed answers.
- Trigger coverage, monotonic revision on upserts, rollback behavior, actual importer
  replay, unchanged source/destination manifests and existing no-delete privileges.
- Anonymous denial, authenticated non-owner denial, owner success and service-role
  success on every new entry point; no direct authenticated table access.
- Full successful assembly, late-page failure, retry exhaustion, cancellation between
  pages and during a request/backoff, no partial publication, and Python fallback
  versus strict CLI parity behavior.

Run the full SQL, API, Pi-operations and web suites, type/lint checks and independent
review. Do not use the legacy giant RPC as the hosted parity oracle when it times out;
use the canonical frozen archive and local SQL equivalence fixtures.

Hosted acceptance must exercise the actual new owner-gated path with an authorized
owner session and the service-role Python reader. Test the failing two-month AQP-LIM
query, each watched route's complete month set, and existing monthly comparisons.
Record page counts, response sizes, maximum request latency, end-to-end latency,
restart counts and final identity/domain digests, never payloads or credentials.

For three consecutive runs on the retained current archive, each hosted SQL page and
metadata request must remain below 5 seconds (margin under the existing 8-second
deadline), each full logical read must finish within the 60-second budget, and final
results must match exactly. Explain timings supplement but do not replace HTTP and
browser-shaped checks. Cold and repeated reads must both be represented. Failure of
these gates blocks cutover rather than authorizing larger timeouts or fewer records.

## Rollout, compatibility and rollback

Use a new additive migration after `20260919000000`; preserve the deployed optimization
and all legacy RPCs. Install revision metadata/triggers and new readers atomically.
No archive/backfill rewrite is required. Validate a service-role replica write before
switching consumers because revision triggers also participate in that write path.

Deploy database support before readers. Then update the web reader, Python reader
and parity CLI together; do not silently fall back to the old giant RPC if the new
protocol is missing or invalid. An old deployed client remains compatible with the
legacy RPC, including its known large-response limitation.

Rollback restores the prior application reader release and, where applicable, the
documented local backend setting. It does not delete replica data or automatically
drop migration objects. A trigger-related incident stops further rollout and requires
an explicitly reviewed corrective migration, not disabling consistency silently.
Application rollback preserves compatibility but does not fix the old multi-month
timeout; collector cutover remains blocked in that state.

Before any eventual Task 11 cutover, separately verify fresh Windows/Pi deltas,
replica parity, secure Pi administration and all existing runtime gates. At the last
operational checkpoint Windows was enabled and Pi collectors disabled; sudo required
renewed interactive authentication. This document does not change those states.
Retain all original archives, candidates and backups. The 24-hour/seven-day observation
periods have not started, and approving this spec does not claim they have.

## Review status and next artifact

The conversational design and written specification are approved. This document is
not an implementation plan or evidence that pagination exists. Review the
implementation plan and agree its execution method before product edits.
The handoff, bootstrap wizard, private diagnostic artifacts and existing untracked
evidence remain outside this specification's commit.
