# Airfare Departed Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove expired departure detail from Pi and Neon while preserving exact historical price statistics and all future-flight observations.

**Architecture:** Keep the Pi authoritative, with immutable departure summary partitions replicated to Neon. A persisted monotonic cutoff fences ingestion before a resumable maintenance coordinator publishes summaries, compacts journals, prunes the replica, and verifies manifests. Monthly readers merge summarized distributions with active observations; flight readers use active detail only.

**Tech Stack:** Python service and JSONL archive, PostgreSQL/Neon migrations and owner-gated RPCs, React/TypeScript, pytest, SQL regression scripts, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-airfare-departed-retention-design.md`

## Global Constraints

- “El vuelo con `flightDate = D` es elegible cuando el día UTC llega al menos a `D + 2 días`.”
- “La poda y las consultas comparten un único corte monotónico registrado”.
- “Preservar todas las observaciones y ofertas de vuelos vigentes, aunque se hayan capturado hace semanas.”
- “Los resúmenes autorizados son la única retención de precios de esos vuelos.”
- “no se modifica silenciosamente la configuración del usuario.”
- “no otorgar `DELETE` general al rol de servicio.”
- “nunca borrar producción antes de ejecutar la comparación de equivalencia en una rama de Neon y en una copia de los archivos de la Pi.”
- Review capacity at “80 %” and act at “90 % de 1 GB”; no automatic notification channel is in scope.
- Preserve Pi archive authority and independent owner watch-document authority from CONTEXT.md and ADR 0004. Only the indefinite append-only retention contract changes.

## Review Focus

- Malformed/truncated journals must block destructive maintenance instead of silently losing unclassified data (Task 3).
- A previously accepted partition with different content must fail closed instead of silently replacing or doubling statistics (Tasks 1–2).
- A crash after atomic replacement but before phase acknowledgement must resume without missing or double-counting rows (Task 4).
- Rollback to a pre-retention writer must not reintroduce expired remote rows or falsely verify a replica (Tasks 2, 4).
- Entirely expired months and fallback reads must retain charts and Usually without presenting an empty collection as never collected (Task 5).

## Files and ownership

Create `services/api/app/services/airfare_retention.py` for cutoff/summary types and pure aggregation, `airfare_retention_store.py` for local partition/journal compaction, and `airfare_retention_runner.py` for phase orchestration. Keep existing sync, history and calendar interfaces in their current files; do not split them incidentally. Add a maintenance CLI at `scripts/fares-retention.py` and operational runbook at `docs/airfare-retention.md`. Two new migrations separate retention correctness from index tuning. Tests belong beside the existing fare, Pi lifecycle, SQL and UI tests listed below.

### Task 1: Define cutoff and exact immutable partition contract

**Files:**

- Create: `services/api/app/services/airfare_retention.py`
- Create: `services/api/tests/fares/test_airfare_retention.py`

**Interfaces:**

- `retention_cutoff(now: datetime) -> date`: exclusive cutoff, UTC date minus one day; delete only `flight_date < cutoff`. At 2026-11-12 UTC the cutoff is 2026-11-11, so November 10 expires and November 11 survives.
- `summarize_departure(origin: str, destination: str, flight_date: date, snapshots: Sequence[Mapping[str, object]], baseline: Sequence[Mapping[str, object]], checks: Sequence[Mapping[str, object]]) -> DepartureSummary`.
- Frozen `DepartureSummary`: `version: int` (1), `origin`, `destination`, `flight_date` (ISO strings), `price_days` and `provider_days` (day -> sorted list of `[decimal price string, positive integer count]`), `unsold_days` (day -> count), `minimum_price: str | None`, `latest_capture: str | None`, `health` (existing WatchHealth counters and latest timestamp). Stable natural key `(origin,destination,flight_date)` and SHA-256 of canonical sorted-key JSON payload; no offers, carrier, error payload or raw response.
- `weighted_median(frequencies: Mapping[Decimal, int]) -> Decimal | None` uses cumulative weights and the mean of the two central observations for even counts; never expands repeated values into rows.

- [ ] **Step 1: Add pure failing tests.** Assert `retention_cutoff(datetime(2026,11,12,tzinfo=UTC)) == date(2026,11,11)`; timezone-equivalent instants yield the same cutoff. Assert `weighted_median({Decimal('10'): 2, Decimal('30'): 2}) == Decimal('20')`, empty -> None, odd/repeated values correct. Assert old captures of future flights survive classification; zero prices count; no-offer snapshots increment unsold counts; baseline natural keys are counted once with their latest persisted value.
- [ ] **Step 2:** Run `npm run api:test -- tests/fares/test_airfare_retention.py -q`; expect missing-module/function failure.
- [ ] **Step 3:** Implement the contract. Derive snapshot cheapest price and pair minimum using existing semantics; summarize canonical logical records, not duplicate physical JSONL lines. Canonicalize decimals without lossy float round trips. Validate counts, dates and finite prices. Test stable hashes under input ordering and reject conflicting payload for an existing partition key in the store task.
- [ ] **Step 4:** Repeat Step 2; expect all tests pass.
- [ ] **Step 5:** Commit only these task files: `feat: define exact departed airfare summaries`.

### Task 2: Add replica summaries, ingress fence and exact readers

**Files:**

- Create: `supabase/migrations/20261112000000_airfare_departed_retention.sql`
- Create: `supabase/tests/airfare_departed_retention.test.sql`
- Reference current definitions: `20261101000000_airfare_confirmed_empty.sql`, `20260928000000_airfare_dirty_month_projection.sql`, history metadata/calendar/manifest definitions in existing migrations.

**Interfaces:**

- `airfare_retention_state`: singleton confirmed exclusive cutoff plus target cutoff and phase; `fare_departure_summaries`: natural key, immutable canonical payload and digest; `airfare_retention_runs`: run UUID, target cutoff, phase and per-departure progress.
- Service-role-only security-definer RPCs with empty search_path: `begin_airfare_retention(p_run_id uuid,p_cutoff date) returns jsonb`, `publish_airfare_departure_summary(p_run_id uuid,p_payload jsonb,p_digest text) returns void`, `prune_airfare_departure(p_run_id uuid,p_origin text,p_destination text,p_flight_date date) returns jsonb`, `finish_airfare_retention(p_run_id uuid,p_manifest jsonb) returns jsonb`.
- Extend existing `airfare_dataset_manifest()` with summary counts/digests and retention state. Extend monthly payload with `retention: {cutoff: string|null, detailExpired: boolean}`. Preserve existing RPC argument signatures and owner authorization.

- [ ] **Step 1: Add transaction-rolled-back SQL tests.** Seed one expired and one future departure in the same month with daily prices `[10,10,30,30]`, repeated baseline values, no-offer captures and board checks. Save monthly historical fields before prune; assert exact equality after summary publication/prune for priceDays, providerDays, unsoldDays, health, latestCapture and pairReference. Exclude revision and intentionally removed board/detail fields from equality. Assert future offer payloads are unchanged and currentBoards/latestBoards/flight projections contain only active dates. Assert all-expired month survives route refresh discovery. Assert partial summary publication cannot authorize deleting an unsummarized departure.
- [ ] **Step 2:** Run `psql "$env:TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/airfare_departed_retention.test.sql` against a disposable migrated database; expect missing tables/RPCs.
- [ ] **Step 3:** Implement additive schema and RPCs. Begin locks state and advances the ingestion fence monotonically only within the UTC grace boundary; retain a distinct target/phase until verification. Triggers reject expired snapshot/baseline/board-check insert/update, including stale clients. Calendar ingress rejects curves containing expired dates. Identical summary replay succeeds; different digest for the same key fails. Prune requires durable matching summary and deletes only that authorized departure, including projection rows. No general DELETE grant.
- [ ] **Step 4:** Replace current reader/refresh implementations in this migration, preserving confirmed-empty behavior. Combine frequency counts with active records using cumulative weighted ranks. Merge expired minima with active departure minima for whole-pair Usually. Preserve health/latestCapture using summaries. Refresh discovery unions summary months with active months; history metadata and calendar horizon share the persisted cutoff. Calendar replacement and deletion use bounded privileged maintenance RPC behavior, never client DELETE. Mark affected routes dirty and increment history revision so old pagination sessions conflict rather than mix states.
- [ ] **Step 5:** Add assertions for unauthorized callers, cutoff regression/future cutoff rejection, conflicting summary payload, stale direct service upsert rejection, identical repeated pruning, and calendar checks surviving unchanged. Repeat Step 2 and existing month projection/history revision/position replay SQL scripts; expect success.
- [ ] **Step 6:** Commit task files: `feat: retain exact airfare summaries in replica`.

### Task 3: Compact the Pi archive without losing future detail

**Files:**

- Create: `services/api/app/services/airfare_retention_store.py`
- Create: `services/api/tests/fares/test_airfare_retention_store.py`
- Modify: `services/api/app/services/fare_history.py`, `fare_calendar.py`, `airfare_data.py`, `airfare_sync.py`, `airfare_baseline_ack.py` in the same services directory.
- Extend: `services/api/tests/fares/test_airfare_sync.py`, `test_calendar_store.py`, `test_airfare_data.py`.

**Interfaces:**

- `RetentionStore(root: Path)`; `read_cutoff() -> date | None`, `publish(summary: DepartureSummary) -> str`, `compact_route(origin: str,destination: str,cutoff: date) -> dict[str, object]`.
- Store summaries as `fares/retention/partitions/<ORIGIN>-<DESTINATION>/<YYYY-MM-DD>.json`; state/phase files under `fares/retention/`. Atomic JSON partition creation verifies existing digest and never replaces different content.
- Extend SourceManifest/DestinationManifest with `summaries` and cutoff/phase metadata, updating all construction sites/test replicas. Continue using `canonical_record_id` for transformed calendar identities.

- [ ] **Step 1: Add tests.** For a mixed route, assert every retained snapshot/baseline/check payload equals its original value, and no expired detail remains. Assert a mixed calendar retains future points, recomputes window/identity, and an all-expired curve disappears; calendar health checks remain byte-equivalent. Assert partition digest mismatch and malformed/unterminated source records abort before replacement. Assert atomically replaced journals rebuild valid physical positions, invalidate baseline acknowledgements and yield equal manifests after replay from byte zero.
- [ ] **Step 2:** Run `npm run api:test -- tests/fares/test_airfare_retention_store.py tests/fares/test_airfare_sync.py tests/fares/test_calendar_store.py tests/fares/test_airfare_data.py -q`; expect new tests fail.
- [ ] **Step 3:** Implement temp-file writes, file fsync, atomic replacement and directory fsync where supported. Persist per-file replacement progress before advancing route phase. Validate the entire source before any destructive replacement; incomplete trailing writes are not silently dropped. Rebuild fingerprints, route indexes, cached file signatures, source positions and cursors. Keep calendar state valid after identity changes. Do not rewrite owner watch documents.
- [ ] **Step 4:** Fence all local append/merge/check/import entry points against the persisted cutoff and pending maintenance state. Filter full/incremental/manual sync input consistently; transform calendars before upload. Include immutable partitions in scan/upload/verification, rejecting absent or conflicting summaries remotely. Merge partition minima/health into local history metadata so fallback reads preserve Usually and health. Use a single lock ordering shared with Task 4; nested writes must not reacquire the maintenance lock.
- [ ] **Step 5:** Repeat Step 2; expect all pass, including future observations captured weeks earlier and a full replay that cannot resurrect departed rows.
- [ ] **Step 6:** Commit task files: `feat: compact departed airfare journals safely`.

### Task 4: Coordinate resumable maintenance and honest verification

**Files:**

- Create: `services/api/app/services/airfare_retention_runner.py`, `scripts/fares-retention.py`
- Create: `ops/pi/systemd/edicius-airfare-retention.service`, `ops/pi/systemd/edicius-airfare-retention.timer`
- Create: `services/api/tests/fares/test_airfare_retention_runner.py`, `ops/pi/tests/test_airfare_retention_lifecycle.py`
- Modify: `services/api/app/services/airfare_sync.py`, `fare_collector.py`, `airfare_request_worker.py`, `fare_budget.py`; `scripts/api.mjs`, `package.json`, `ops/pi/install.sh`, `ops/pi/verify.sh`.

**Interfaces:**

- `RetentionRunner(root: Path, remote: SupabaseAirfare).run(*, now: datetime, dry_run: bool = True) -> RetentionReport`.
- `RetentionReport` includes run_id, exclusive cutoff, phase, per-dataset counts/digests, mismatches and error; phase values `summarized`, `compacted`, `pruned`, `verified` plus pre-publication pending state.
- `npm run fares:retention -- --dry-run` plans only; `--apply` starts/resumes the persisted run. Exit 0 only for a successful dry run or verified maintenance; failure exits nonzero with machine-readable phase/run identifier.

- [ ] **Step 1: Add state-machine tests.** Inject failure before/after each phase and each local replacement, recreate runner, resume, and assert one summary per natural key, stable future payloads and final equal keys/digests. A remote outage/mismatch must leave verified false and writers blocked. Concurrent collector/manual worker/sync cannot mutate during maintenance. Restart after remote success/local acknowledgement loss resumes idempotently. Replaying old input into the server still fails the ingress fence.
- [ ] **Step 2:** Run `npm run api:test -- tests/fares/test_airfare_retention_runner.py -q` and the Pi lifecycle pytest test using the same Python environment; expect failures.
- [ ] **Step 3:** Implement durable coordination: acquire exclusive maintenance exclusion across board/calendar passes, manual worker and sync in a documented fixed lock order; freeze source; persist target; fence server; publish and verify partitions; compact Pi; replay retained rows/calendar replacements; prune remote detail; refresh projections; compare complete manifests and keys; mark verified; release maintenance gate. Process locks alone are insufficient after a crash: persisted nonverified state blocks ordinary writers on startup until resumed. Do not call the public lock-taking sync API while already holding its lock; expose/reuse an internal locked path. Add a daily UTC systemd timer and oneshot service that call the idempotent `--apply` path, with the same durable-state and service-user permissions as other Airfare units; extend installation and verification, but leave the timer disabled until the initial supervised retention run verifies successfully.
- [ ] **Step 4:** Extend AirfareSync.verify to require matching cutoff, partition digests, datasets and completed phase. Compare transformed calendar keys as well as counts. Never treat remote outage or incomplete run as verified. Dry run prints counts/estimated sizes and writes neither state nor source.
- [ ] **Step 5:** Repeat Step 2 plus `npm run api:test -- tests/fares/test_pass_lock.py tests/fares/test_airfare_sync.py -q`; expect pass. Add Linux subprocess crash/lock-release coverage to the Pi lifecycle test; Windows-only success is insufficient for Pi deployment.
- [ ] **Step 6:** Commit task files: `feat: coordinate resumable airfare retention`.

### Task 5: Keep historical charts and clearly expire flight detail

**Files:**

- Modify: `apps/web/src/features/airfare/data/fareProjections.ts`, `hooks/useFareProjections.ts`, `ui/RouteDetail.tsx`, `ui/AnalysisPanel.tsx`.
- Modify fallback API shape as needed: `apps/web/src/shared/api/fares.ts`, `services/api/app/routers/fares.py`, `services/api/app/services/airfare_data.py`.
- Extend: `apps/web/src/features/airfare/data/fareProjections.test.ts`, `hooks/useFareProjections.test.tsx`, `ui/RouteDetail.test.tsx`, `ui/AnalysisPanel.test.tsx`, `ui/ProjectedFlightTable.test.tsx`.

**Interfaces:**

- `FareMonthProjection.retention?: {cutoff: string | null; detailExpired: boolean}` is additive for rolling deployment. Missing means legacy response, not proof of expiry. New server/local fallback must supply matching metadata and summarized historical buckets.
- Expired-month message: `Flight details have expired. Price history is still available.`

- [ ] **Step 1: Add failing tests.** An all-expired month retains exact chart buckets and Usually, shows the explicit expiry message and no Flights seen rows, and keeps the watch selected. A mixed month shows every future flight and no expired one. Missing old-server metadata parses safely. Fallback after a missing projection still retains summarized buckets; do not reconstruct historical charts from future snapshots alone. Horizon excludes expired dates.
- [ ] **Step 2:** Run `npm run test -w web -- src/features/airfare/data/fareProjections.test.ts src/features/airfare/hooks/useFareProjections.test.tsx src/features/airfare/ui/RouteDetail.test.tsx src/features/airfare/ui/AnalysisPanel.test.tsx src/features/airfare/ui/ProjectedFlightTable.test.tsx`; expect failures.
- [ ] **Step 3:** Implement optional parsing and propagate retention metadata through fallback/history response. Render expiry based on recorded cutoff/month rather than browser clock. Keep historical chart display independent of detailed flight availability, without changing watch preferences or confirmed-empty semantics.
- [ ] **Step 4:** Repeat Step 2, then `npm run typecheck`; expect success.
- [ ] **Step 5:** Commit task files: `feat: display retained airfare history after detail expiry`.

### Task 6: Reclaim capacity and document a gated rollout

**Files:**

- Create: `supabase/migrations/20261112010000_airfare_retention_indexes.sql`, `supabase/tests/airfare_retention_indexes.test.sql`, `docs/airfare-retention.md`.
- Modify: `docs/airfare-sync-contract.md`, `docs/ADRs/0004-pi-collectors-supabase-data-plane.md`, `docs/ADRs/0002-airfare-price-history-store.md`, `docs/ADRs/0003-airfare-supabase-read-store.md`, `CONTEXT.md`.

**Interfaces:**

- Runbook separates schema/application rollout from operator maintenance. It records database/table/index sizes, source counts, summary sizes, target cutoff, run ID and before/after evidence; credentials and raw expired detail never enter evidence reports.

- [ ] **Step 1: Add SQL assertions.** Baseline natural uniqueness remains; the duplicate `fare_baseline_route_flight_price_date_idx` is absent; replacement calendar-health index on `(origin,destination,checked_at)` has `WHERE kind = 'calendar'`. Capture EXPLAIN (ANALYZE, BUFFERS) for actual calendar health queries on representative staging rows before and after; verify equivalent results and no material regression.
- [ ] **Step 2:** Run `psql "$env:TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/airfare_retention_indexes.test.sql`; expect failure before migration.
- [ ] **Step 3:** Implement the index migration only after confirming current definitions and query predicates; drop only the redundant nonunique baseline index, and replace the calendar index with the partial index. Repeat Step 2; expect success.
- [ ] **Step 4:** Update domain/ADR contracts explicitly: durable historical archive now consists of active detail plus immutable numeric summaries; append-only is no longer indefinite. Preserve Pi authority, owner documents, and separate replica rollback. Link the retention decision from older ADRs; remove contradictory claims from the synchronization contract, including source-key deletion and retained reconciliation copies.
- [ ] **Step 5:** Write the rollout checklist below into the runbook, including exact deployment-specific commands once environment paths are verified. This task prepares documentation; it does not run production maintenance.

Rollout checklist:

1. On a disposable Neon branch and copied Pi source, capture canonical pre-retention projections and full manifests. Run maintenance and compare historical fields exactly; compare future detail values and complete remaining key sets. Repeat maintenance and reset incremental cursors to byte zero; verify no changes or resurrection.
2. Deploy additive schema, ingress guards, summary-aware readers and compatible application together before enabling maintenance. Check old writers are rejected below the cutoff and all local writers honor the durable maintenance gate. Do not enable a pruning timer as part of schema migration.
3. Inventory reconciliation folders, drift samples and any other copies outside `/fares`; classify files by contained departure dates. After operational source verification, scrub expired portions or delete wholly expired copies with exact reviewed paths. Retain only aggregate evidence. Do not declare retention complete while these copies remain. Calendar checks are excluded and need their own later age policy.
4. Stop relevant Pi Airfare collection/request/sync units for the first operational window, record previously active units, run dry-run then explicit apply/resume, and keep units stopped after any failure. Resume only after full manifest/key equality, required projection checks and verified state. Subsequent daily runs use the same maintenance exclusion and UTC cutoff; catching up must process all eligible dates.
5. Measure `pg_database_size(current_database())`, `pg_total_relation_size` for affected tables/indexes, and retained-summary bytes before/after. Ordinary DELETE/VACUUM may not lower logical size. If needed, schedule table/index rewrite with sufficient temporary disk headroom and an exclusive-lock window (targeted VACUUM FULL/REINDEX as operator commands, outside migration transaction); remeasure and repeat manifest/projection verification before resuming. Record capacity limitation if safe rewrite headroom is unavailable rather than claim reclamation.
6. Record manual review at 80% and action at 90% of the provider's 1 GB quota, including the exact byte basis used by its usage metric. This is manual monitoring, not an automatic alert. Future-flight volume can still exceed the quota.
7. Rollback disables maintenance and uses a retention-compatible writer/reader release. Never restore pruned detail from old source copies or roll back the cutoff. Resume a pending run rather than rerunning summaries from already compacted sources.

- [ ] **Step 6:** Run `npm run api:test -- tests/fares -q`, Pi lifecycle tests, the retention SQL tests plus existing projection/history regressions on the disposable database, `npm run test -w web -- src/features/airfare`, `npm run typecheck`, `npm run lint:api`, and `git diff --check`. Expect all pass; record any unavailable environment explicitly. Run formatting on changed files only. Review the final diff for accidental schema-time deletion and unrestricted service-role grants.
- [ ] **Step 7:** Commit only this task's files: `docs: define airfare retention rollout and capacity checks`.

## Execution handoff

The approved execution preference is subagents. Implement tasks in dependency order (1–6); review each task before its dependent task. Production deletion remains a separate operational rollout after staging equivalence and concrete evidence, never an implicit effect of executing this code plan.
