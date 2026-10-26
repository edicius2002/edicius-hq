# SEACE Exclusion Response Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make SEACE exclusion and restoration correct and visibly immediate.

**Architecture:** Keep Supabase as the write and read authority. Escape batch restore keys for PostgREST; optimistically update only the active page cache and reconcile server pages after the write.

**Tech Stack:** React, TanStack Query, Supabase PostgREST, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-seace-exclusion-response-design.md`

## Global Constraints

- Do not deploy or migrate production as part of local implementation.
- Preserve page membership, sorting, filters, and owner scope.
- Do not change unrelated pages.

## Review Focus

- JSON-shaped keys containing quotes, commas, and backslashes must restore with bounded PostgREST requests.
- Failed writes with no completed chunk must restore visible rows and selection; partial restores must refetch the server state.
- An in-flight page response must not undo an optimistic row removal.
- Moving between included and excluded views during the write must eventually show server-confirmed data.
- A selection spanning pages must not leave an incorrect permanent total.

---

### Task 1: Safe batch restore

**Files:** `apps/web/src/features/seace/data.ts`, `apps/web/src/features/seace/data.test.ts`

**Interface:** `setExcludedMany(keys, excluded)` remains unchanged.

- [x] Add regression tests for raw single-key equality, escaped batch filters, bounded URLs, and partial failures.
- [x] Implement and verify both filter forms against real production rows; bound larger batches by encoded URL length.

### Task 2: Immediate table response

**Files:** `apps/web/src/features/seace/SeacePage.tsx`, `apps/web/src/features/seace/SeacePage.test.tsx`

**Interface:** The selected rows leave the active page before the write settles. The server refresh reconciles final rows and totals.

- [x] Add failing tests for immediate removal, failed-write rollback, selection after switching views, and prefetch during an in-flight write and active reload.
- [x] Implement the cache update, rollback, and reconciliation.
- [x] Reconcile partial restores and keep pagination stable while the write is pending.
- [x] Run focused tests and then the full web suite, typecheck, lint, and build.

### Task 3: Measurement and cleanup

**Files:** `docs/seace-exclusion-performance-2026-10-25.md`

- [x] Record production baseline, the deterministic local feedback loop, and limits of the comparison.
- [x] Verify the original production test exclusion was returned to its starting state: Closed/Excluded has 668 records again.
- [x] Measure five paired real-browser exclusions against the production backend and verify single and batch restore in the database.
- [x] Check the final diff and status.
