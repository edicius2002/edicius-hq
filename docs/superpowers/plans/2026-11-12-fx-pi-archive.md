# FX Pi Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Pi's SQLite FX archive durable, import all existing history, and retain Neon as the complete web read replica.

**Architecture:** Extend the existing transactional SQLite store with permanent observations. Keep collection and replication separate, suppress unchanged future captures using a ten-minute commercial heartbeat, and provide bounded, resumable archive administration through the existing cloud boundary. Repository code currently names that boundary `CollectorCloud`/Supabase; use the configured deployment endpoint rather than introducing a second Neon client.

**Tech Stack:** Python 3.12, sqlite3 WAL/FULL, httpx/PostgREST, pytest, existing systemd deployment and TypeScript/Vitest web tests.

**Spec:** `docs/superpowers/specs/2026-11-12-fx-pi-archive-design.md`

## Global Constraints

- “Cada observación aceptada se confirma primero en el SQLite de la Pi y después se intenta replicar a Neon.”
- “El acuse elimina la entrada de la cola, nunca la entrada histórica.”
- “El histórico actual de Neon, desde el 1 de octubre de 2026, se importa a la Pi antes de declararla fuente principal.” Existing `HISTORY_START` is `2026-10-01T05:00:00+00:00` (Lima midnight).
- “No se borran filas de Neon durante esta migración.”
- Preserve identity `(owner, source, effective, observed)` and existing RPC contracts.
- “Si todo sigue igual, se guarda una observación de latido al cumplirse diez minutos desde la última observación persistida, comparando con ella.” Commercial stale threshold remains fifteen minutes.
- “Una fuente que no respondió no genera latido.” Reference freshness stays unchanged.
- “Los registros históricos ya almacenados en Neon se importan íntegros, incluidos los repetidos; la reducción afecta solo a capturas futuras.”
- “No se archivan HTML, respuestas HTTP, cookies ni secretos.”
- “Un comando de exportación de respaldo del SQLite activo usa la API de backup de SQLite”. No automatic third-copy destination is introduced.

## Review Focus

- Equivalent timezone/decimal/JSON representations must compare equal without creating duplicate logical keys (Tasks 1 and 4).
- Disk-full/SQLite transaction failure must not send the failed observation or mark its acquisition successful (Task 2).
- Late reference revisions and several effective dates in one response must compare against the corresponding effective date (Task 2).
- A crash after remote acceptance but before cursor persistence must replay safely; a foreign-owner checkpoint must be rejected (Task 4).
- Concurrent collection during historical import must not make final reconciliation miss older keys or falsely declare authority (Tasks 4 and 5).

## File Map

- Extend `services/api/app/services/fx/store.py`: permanent archive, migration, paging, transactional capture, backup.
- Add `services/api/app/services/fx/archive_rows.py`: shared row validation/canonicalization and cursor types.
- Add `services/api/app/services/fx/retention.py`: future-capture change/heartbeat decision.
- Extend `services/api/app/services/fx/collector.py`: retention and local-failure handling; factor queue drain.
- Extend `services/api/app/services/collector_cloud.py`: owner-scoped paginated FX reads.
- Add `services/api/app/services/fx/archive.py`: import, replay, reconciliation and checkpoints.
- Add `scripts/fx-archive.py`; extend `scripts/api.mjs` and `package.json`: operator CLI.
- Add tests `services/api/tests/test_fx_archive_rows.py`, `test_fx_store.py`, `test_fx_retention.py`, `test_fx_archive.py`, `test_fx_archive_cli.py`; extend `test_fx_collector.py` and `test_collector_cloud.py`.
- Update `docs/pi-collectors-runbook.md`, `CONTEXT.md`, `docs/ADRs/0004-pi-collectors-supabase-data-plane.md`, and `ops/pi/tests/test_fx_lifecycle.py` for delivery and authority.

Run focused Python commands below from `services/api` using its virtualenv interpreter (`.venv/Scripts/python.exe` on Windows, `.venv/bin/python` on Linux). No task executes a production migration.

### Task 1: Durable store and canonical archive rows

**Files:** `archive_rows.py`, `store.py`, `test_fx_archive_rows.py`, `test_fx_store.py` from the map.

**Interfaces:**

- `archive_rows.FxKey = tuple[str, str, str]` is `(source, effective_at, observed_at)` for one separately validated owner.
- `normalize_row(row: Mapping[str, Any], owner_id: UUID) -> dict[str, Any]`; `row_key(row: Mapping[str, Any]) -> FxKey`; `canonical_bytes(row: Mapping[str, Any]) -> bytes`.
- `Store.archive_page(*, after: FxKey | None = None, limit: int = 500) -> list[dict[str, Any]]` orders by the full key, exclusively after cursor.
- `Store.import_rows(rows: list[dict[str, Any]]) -> int` returns inserted count, changing neither outbox nor health/due.
- `Store.latest(source: str, *, effective_at: datetime | None = None) -> dict[str, Any] | None` selects latest observed record, optionally for one effective date.
- `Store.backup(destination: Path) -> None` uses `Connection.backup` and rejects the live database destination or an existing output.

- [ ] Write `test_normalization_preserves_identity_and_safe_content`: assert equivalent UTC offsets, `3.400`/`3.4`, and reordered context keys produce identical canonical bytes and keys; assert wrong owner, unknown columns/context, naive timestamps and nonfinite rates raise `ValueError`. Preserve Decimal precision when reading JSON numerics.
- [ ] Write store tests with exact invariants: `test_ack_leaves_archive` asserts archive length `1` and pending `[]`; `test_legacy_outbox_migration_is_idempotent` reopens twice and asserts one archived key; `test_save_rollback_is_atomic` injects failure after archive insert and asserts no archive/outbox/due/health updates; `test_existing_key_is_immutable` imports changed content at an existing key and asserts original content remains. Add owner isolation, two-page traversal, and backup integrity tests (`pragma integrity_check == 'ok'`).
- [ ] Run `python -m pytest tests/test_fx_archive_rows.py tests/test_fx_store.py -q`; expect missing interfaces/failing assertions.
- [ ] Implement strict safe wire normalization: exact allowed columns, UUID owner, aware UTC timestamps with fixed microsecond precision, finite Decimal strings, safe context, sorted compact JSON for digest. Preserve original payload content on duplicate keys. Add `observations` with the existing five-column outbox shape and primary key. Within a transaction migrate existing queued rows into archive without deleting queued data; normalize their local key representation consistently. Preserve all existing queued records, including historical boundary anomalies, for inspection. Readonly opening must not migrate. Make `save` insert archive plus outbox and state atomically; enqueue only the authoritative stored payload for a duplicate key, never conflicting incoming content. Keep WAL/FULL.
- [ ] Run the focused tests plus `python -m pytest tests/test_fx_collector.py -q`; expect all pass.
- [ ] Commit only these task files: `git commit -m "feat: retain durable FX observations on Pi"` after explicit `git add` paths.

### Task 2: Change retention and acquisition failures

**Files:** `retention.py`, `collector.py`, `test_fx_retention.py`, `test_fx_collector.py`.

**Interfaces:**

- `retention.should_persist(observation: Observation, previous: Mapping[str, Any] | None) -> bool`.
- `collector.drain_outbox(store: Store, cloud: Any) -> int` returns acknowledged count or raises, preserving unacknowledged rows.
- Retain the existing `collect_once(...) -> dict[str, int]` API; consume Task 1's `Store.latest`.

- [ ] Add `test_commercial_heartbeat_uses_last_persisted_observation`: for unchanged rates/context at `t`, `t+5m`, `t+9m59s`, `t+10m`, decisions equal `[True, False, False, True]`. Commercial `effective_at` advancing with observation time must not itself count as a price/context change. Assert buy, sell or context changes persist immediately.
- [ ] Add `test_reference_revision_retention`: unchanged price/context for a given effective date is suppressed, a changed value/context or new effective date persists; a response containing old and new dates compares each date separately. Add backwards observed-time input test: unchanged earlier capture creates no heartbeat.
- [ ] Add `test_local_failure_never_reaches_cloud`: inject `sqlite3.OperationalError` during save and assert failed increments, failed row absent remotely and locally, another healthy source still collects. Add `test_outage_retry_preserves_archive` and `test_failed_fetch_never_creates_heartbeat`; assert health last-success updates on successful suppressed captures but not failed ones. Assert short remote acknowledgement leaves queue intact.
- [ ] Run `python -m pytest tests/test_fx_retention.py tests/test_fx_collector.py -q`; expect failures on new behavior.
- [ ] Implement policy comparing normalized Decimal values/context; references use effective-date lookup, commercial uses last persisted observation. Retention never applies to imports. Catch SQLite errors at acquisition and health-report boundaries, report sanitized local-storage failure and avoid a second unsafe state write; keep processing other sources where possible. Factor existing replay into `drain_outbox`, retaining its history-start filtering and full-batch acknowledgement semantics.
- [ ] Run the focused tests; expect PASS with unchanged scheduling and provider backoff tests.
- [ ] Commit task files with message `feat: retain FX changes and healthy ten-minute heartbeats`.

### Task 3: Bounded owner-scoped cloud history reads

**Files:** `services/api/app/services/collector_cloud.py`, `services/api/tests/test_collector_cloud.py`.

**Interfaces:** `CollectorCloud.list_fx(*, after: FxKey | None = None, limit: int = 500) -> list[dict[str, Any]]`; consumes Task 1 normalization/key representation.

- [ ] Add `test_list_fx_scopes_owner_and_pages_full_key` using `httpx.MockTransport`: assert `owner_id=eq.<configured owner>`, explicit seven-column selection, ascending `source,effective_at,observed_at` ordering and exclusive lexicographic cursor filter. Mock equal effective times with distinct observed times across a two-row page and assert no missing keys.
- [ ] Add `test_list_fx_rejects_invalid_rows_and_cursor`: foreign owner, invalid timestamp/source, invalid page size and malformed cursor fail with sanitized errors; empty page returns `[]`. Assert historical records from `HISTORY_START` remain and earlier effective dates are filtered by the remote query.
- [ ] Run `python -m pytest tests/test_collector_cloud.py -q`; expect new tests fail.
- [ ] Implement the method through `_request`, with parameterized PostgREST query strings built only from validated values. Parse FX JSON numeric values losslessly (Decimal before float conversion) without altering other cloud methods' response contracts. Validate complete rows before returning the page. Keep service credentials inside the existing boundary.
- [ ] Run the same tests plus Task 1 normalization tests; expect PASS.
- [ ] Commit with message `feat: page owner-scoped FX replica history`.

### Task 4: Resumable import, replay, comparison and backup CLI

**Files:** `archive.py`, `scripts/fx-archive.py`, `scripts/api.mjs`, `package.json`, `test_fx_archive.py`, `test_fx_archive_cli.py`.

**Interfaces:**

- `import_history(store: Store, cloud: CollectorCloud, *, checkpoint: Path, batch_size: int = 500) -> int`.
- `replay_history(store: Store, cloud: CollectorCloud, *, checkpoint: Path, batch_size: int = 500) -> int`.
- `compare_history(store: Store, cloud: CollectorCloud, *, batch_size: int = 500) -> dict[str, dict[str, Any]]`: every `SOURCES` entry includes `local_count`, `remote_count`, `local_digest`, `remote_digest`, `matches`; empty sources included.
- CLI: `fx-archive.py import|replay --checkpoint PATH [--batch-size 500]`, `compare`, `drain`, `backup --output PATH`; npm `fx:archive` routes through API dispatcher. Exit `0` on success/equality, `1` on operational error/mismatch, argparse `2` on invalid arguments.

- [ ] Add `test_import_restart_is_idempotent`: three pages, crash after a committed page before checkpoint, resume and assert all keys/content preserved exactly once; import never populates queue or alters health. Add `test_import_keeps_historical_repeated_prices` asserting all distinct historical timestamp keys survive.
- [ ] Add `test_replay_restarts_after_remote_acceptance`: crash before checkpoint persistence, repeat accepted page and assert no duplicated remote keys. Short acknowledgements must not advance cursor. Add `test_checkpoint_rejects_owner_mode_or_endpoint_mismatch`.
- [ ] Add `test_compare_detects_same_count_different_content`: differing context or price produces `matches == False` despite equal counts; equivalent numeric/time/JSON representations match. Assert all nine source entries exist and one missing key fails comparison.
- [ ] Add CLI tests: offline backup requires only owner/local config; backup can be opened and checked; import/replay/drain obtain existing `fx` process lock and never fetch providers; invalid/foreign checkpoints and errors emit no credentials/payloads. Compare is readonly locally and exits nonzero on mismatch.
- [ ] Run `python -m pytest tests/test_fx_archive.py tests/test_fx_archive_cli.py -q`; expect failures.
- [ ] Implement bounded loops, checkpoint JSON version/owner/operation/endpoint fingerprint/full last key, and atomic same-directory temporary-write/replace after local commit or remote full acknowledgement only. Replay uses only idempotent upserts and never deletes remotely. Comparison streams sorted canonical rows into per-source SHA-256 with newline delimiters, count and digest including keys/content. Compare the retained history window from `HISTORY_START` and report any older local anomaly separately as a migration blocker, never silently delete it.
- [ ] Implement CLI using existing config, durable path and lock, safely closing cloud/store. Imports release the lock between committed batches so collection can continue; each page remains atomic. A resumed online import may miss rows inserted behind its cursor: document that final paused import must restart with a NEW checkpoint. Backup uses SQLite's online API. No automatic authority flag is set by any command.
- [ ] Run focused tests plus `python -m pytest tests/test_fx_store.py tests/test_fx_collector.py tests/test_collector_cloud.py -q`; expect PASS.
- [ ] Commit with message `feat: add FX archive import replay and integrity tooling`.

### Task 5: Deployment runbook, authority and compatibility verification

**Files:** `docs/pi-collectors-runbook.md`, `CONTEXT.md`, `docs/ADRs/0004-pi-collectors-supabase-data-plane.md`, `ops/pi/tests/test_fx_lifecycle.py`; extend `apps/web/src/features/dashboard/fx/model.test.ts` only if existing tests do not pin stale behavior.

**Interfaces:** Consume Task 4 CLI commands and existing pinned deployment service `/opt/edicius-hq/current/scripts/fx-collect.py`, state `/var/lib/edicius-hq/fx/outbox.sqlite`, environment `/etc/edicius-hq/collectors.env`, service user `edicius-collector`.

- [ ] Update lifecycle test currently asserting no `backfill` text: distinguish prohibited upstream pre-October historical fetching from required replica-to-Pi historical import. Assert runbook contains backup, final fresh-checkpoint import, all-source digest comparison, timer resume and rollback preservation. Add/retain web assertions that a commercial successful observation is fresh at ten minutes and stale past fifteen, and failed source receives no invented fresh point.
- [ ] Run `python -m pytest ../../ops/pi/tests/test_fx_lifecycle.py -q`; expect documentation assertions fail before edits.
- [ ] Document an executable operator sequence under the existing pinned-release environment-loading convention: verify target release/owner/config and existing remote baseline; produce SQLite API backup; deploy archive-capable code; verify live archive and queue writes; import with checkpoint `fx/import-initial.json` while collecting; stop `edicius-fx.timer` and wait for service inactivity; run `drain`; run final import with NEW `fx/import-final.json`; require zero pending rows and matching counts/digests for every source; record release SHA and comparison output; only then record Pi authority and resume timer. If checks fail, preserve both databases, keep authority undeclared, restore collection with archive-capable code, investigate and repeat final reconciliation. Do not roll back to capture code that fails to retain archive rows after cutover.
- [ ] Document post-resume verification: collect healthy/failing provider fixtures and check new changes/heartbeat; take another brief timer pause, drain and compare to avoid comparing two moving datasets, then resume. Verify unchanged web latest/history RPCs and accepted lower density in 1D/7D charts. Replay disaster drill uses isolated fixture destination; no production truncate. Document Pi-card-loss exposure for unreplicated rows and absence of automatic third copy.
- [ ] Add FX archive/replica definitions to `CONTEXT.md` and FX row/addendum to ADR 0004. State this is the intended authority after successful migration verification, not evidence that deployment already happened. Retain existing Airfare/X/market decisions. Follow domain-modeling instructions when editing those docs.
- [ ] Run `python -m pytest tests/test_fx_archive_rows.py tests/test_fx_store.py tests/test_fx_retention.py tests/test_fx_collector.py tests/test_fx_archive.py tests/test_fx_archive_cli.py tests/test_collector_cloud.py ../../ops/pi/tests/test_fx_lifecycle.py -q`; expected PASS (Linux-only calendar check may skip on Windows).
- [ ] From repository root run `npm run lint:api`, `npm run typecheck:api`, `npm run test -- --run src/features/dashboard/fx`; expect clean lint/typecheck and passing FX web tests. Run existing SQL FX tests using the repository's local database test workflow only if SQL changes prove necessary; no RPC/schema changes are planned.
- [ ] Commit explicit task files with message `docs: document verified FX archive cutover and recovery`.

## Handoff and rollout boundary

Tasks 1–5 deliver tested code and a reviewable migration procedure. Implementation does not claim production authority or execute deployment/backfill. The live operator must verify the pinned environment, inspect counts and integrity, execute the documented import/cutover, and retain comparison evidence before the Pi is declared the historical authority. Do not delete or truncate either copy in deployment or rollback.
