# Confirmed Empty Airfare Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show valid current offers and confirmed empty departures accurately after manual Fetch and reload, while keeping the fare archive intact.

**Architecture:** Parse explicit empty Google itinerary blocks separately from drift, then confirm emptiness with a second metered request. Store `no-offers` as a successful check, replicate its latest per-departure state through Supabase, and make the web derive current availability from checks while leaving historical observations available separately.

**Tech Stack:** Python 3.12/FastAPI/pytest, PostgreSQL/Supabase migrations, React/TypeScript/Vitest.

**Spec:** `docs/superpowers/specs/2026-11-01-airfare-confirmed-empty-design.md`

## Global Constraints

- Preserve the append-only Pi archive and owner-gated Supabase reads; no zero-price or empty fare snapshots.
- A confirmed empty requires two well-formed Google responses; both provider requests use the existing pacer, concurrency slots, daily budget and ledger.
- A technical error never clears a previously confirmed current state.
- Every manual Fetch may query all dates again; no cooldown, repeated-request warning, or skip inferred from another date.
- Work only in `fix/airfare-confirmed-empty`; do not deploy production.

## Review Focus

- Main itinerary block absent while best block has offers: remain `parse-drift`, not an incomplete success (Task 1 test).
- First empty, second valid: publish all second-response offers without marking empty (Task 2 test).
- First empty, retry budget exhausted: record a technical failure; retain previous confirmed state (Task 2 test).
- Empty then later unchanged valid board: restore current offers from the historical snapshot (Tasks 3 and 4 tests).
- Legacy request/projection payloads during rollout: parse without claiming an old board is verified current (Task 4 test).

---

### Task 1: Parse explicit empty Google responses

**Files:** Modify `services/api/app/adapters/fares/google_flights.py`; test `services/api/tests/fares/test_google_flights_parsing.py`.

**Interfaces:** `parse_payload(payload: Any, currency: str) -> list[FareOffer]` continues to raise `FareError('no-offers')` for a well-formed empty board and `FareError('parse-drift')` for an absent/malformed main block.

- [x] Add regression tests for explicit `payload[3] is None` with both blocks empty, valid best plus absent main block, malformed main block, and valid rest plus null best.
- [x] Run the focused parser test and confirm the explicit-null case fails on the old parser.
- [x] Make `_itinerary_rows` distinguish explicit null from absent/malformed; keep complete-board protection.
- [x] Run the focused parser tests, formatter and linter; commit this task.

### Task 2: Confirm and record no-offers in the collector and worker

**Files:** Modify `services/api/app/services/fare_collector.py`, `services/api/app/services/airfare_request_worker.py`; test `services/api/tests/fares/test_fares_endpoint.py`, `services/api/tests/fares/test_budget_ledger.py`, `services/api/tests/test_airfare_request_worker.py` and focused concurrency tests.

**Interfaces:** `RouteResult.no_offers: bool = False`; `CollectionReport.no_offers: int`; manual result gains `noOffers: int`. The first `no-offers` result remains provisional until a second metered request resolves it. A confirmed empty appends `fare_checks.outcome='no-offers'` and returns `ok=True, no_offers=True, offers=0` without a snapshot.

- [x] Add failing tests for two empty replies, empty then offers, empty then error, and exhausted budget before confirmation; assert request-ledger count and recorded check outcome.
- [x] Run the focused tests and confirm the failure is the old one-response/refusal behavior.
- [x] Implement a confirmation path within `collect` that uses the same pacer, slot and `DailyBudget` for the second request in both serial and concurrent modes. Keep errors as `outcome='error'` and do not update confirmed availability.
- [x] Add an all-empty worker test asserting sync and completion with `noOffers`, then implement the worker count and result field.
- [x] Run collector, budget, pacing and worker suites; commit this task.

### Task 3: Project durable current availability from checks

**Files:** Create a forward-only SQL migration under `supabase/migrations/` after the latest existing timestamp; test `supabase/tests/airfare_month_projection.test.sql`.

**Interfaces:** Monthly projection gains `departureChecks: [{ flightDate, checkedAt, outcome, errorCode? }]` for the latest confirmed and latest attempted check per date, and `currentBoards` whose dates exclude a latest confirmed `no-offers`. Historical `latestBoards` and price series remain unchanged. Flight projections mark current presence using the same confirmed-state rule. `changed`, `unchanged` and `rebaselined` count as confirmed offers; `error` never supersedes a confirmed status.

- [x] Add a SQL-level regression scenario: offer snapshot → confirmed `no-offers` → error → valid `unchanged`, asserting blank current board through the first three states and restoration in the fourth, with history retained.
- [x] Run the SQL regression and confirm it fails before the migration.
- [x] Extend `refresh_fare_month_projection` using the latest existing definition; derive latest confirmed state by `(checked_at, record_id)` and use it for current boards and flight presence. Update the flight-page read so dates confirmed empty are absent from the current table. Keep existing RLS and grants.
- [x] Run local Supabase migration/integration checks and verify owner/non-owner reads; commit this task.

### Task 4: Read and display current versus historical state

**Files:** Modify `apps/web/src/features/airfare/data/airfareRequests.ts`, `data/fareProjections.ts`, `hooks/useFareProjections.ts`, `lib/collectNotice.ts`, `hooks/useRouteCollection.ts`, `ui/RouteList.tsx`, `ui/AnalysisPanel.tsx` and focused tests/CSS as needed. Extend the archive fallback only where necessary to avoid treating unknown availability as current.

**Interfaces:** Optional `AirfareRequestResult.noOffers` supports old and new Pi results. `FareMonthProjection.currentBoards` and `departureChecks` are parsed with a safe legacy fallback that reports current availability as unknown, never rebrands old `latestBoards` as current. The current departure chart and flight table consume confirmed current offers; history uses historical snapshots/price series. Month summary remains visible after reload and names offers, confirmed empty, failed and skipped counts with check times.

- [x] Add failing decoder/notice tests for old and new request results and for all-empty completion without the warning triangle.
- [x] Add failing projection/UI tests for valid adjacent dates, confirmed blank date, historical capture date, later valid restoration, technical error preserving confirmed state, and reload from Supabase projection.
- [x] Implement typed projection parsing, current-board selection, visible persistent status and historical labeling. Retain invalidation after all completed syncs; do not add repeated-fetch warnings.
- [x] Run the focused Vitest suites, typecheck, lint and build; commit this task.

### Task 5: End-to-end branch verification

**Files:** Fix only defects exposed by the end-to-end checks; update the plan's checked steps and deployment notes if needed.

- [x] Run the full API and web test suites, format/lint/type checks, and any local Supabase integration tests available.
- [x] Verify a deterministic AEP–ARI-like mix of valid/empty dates through collector → sync/projection → browser data model; ensure an empty date later restores on a valid Fetch.
- [x] Check `git diff`, preserve the unrelated untracked document, and run a final branch review; commit any fixes.
- [x] Report the branch, commits, tests, and remaining deployment steps without deploying.

## Deployment sequence after branch review

1. Apply `20261101000000_airfare_confirmed_empty.sql` in Supabase. The migration queues existing Airfare projection routes for a full refresh; it does not rewrite the append-only archive.
2. Deploy the updated Pi collector to `bodas`, then run its normal Supabase sync to drain the queued projection routes. Confirm the selected route/month projection contains `currentBoards` and `departureChecks` before deploying the web change.
3. Deploy the web build. Perform a manual Fetch on an AEP–ARI-like sparse month and confirm the page reports valid offers and confirmed empty dates separately, with older prices dated as historical. Fetch again to confirm a later offer restores the current view.

The branch has not been deployed to production.
