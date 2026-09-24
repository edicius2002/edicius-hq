# Investing Bar Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show previously loaded chart history during asset swaps and reloads without waiting for an expired Supabase row to refresh.

**Architecture:** React Query retains series in memory. A dedicated owner-scoped IndexedDB store supplies a validated initial series after reload. Supabase remains the source for the saved row, and the Pi collector remains the source for updates; both can publish a newer series over an older initial one.

**Tech Stack:** React 19, TanStack Query 5, Supabase JS, native IndexedDB, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-24-investing-bar-cache-design.md`

## Global Constraints

- Keep the chart key as symbol, timeframe and extended mode.
- Persist bars only; never persist Supabase credentials or application documents.
- A failed IndexedDB operation must leave the existing network path functional.
- Keep a clear stale label until a fresh collector result arrives.

## Review Focus

- Rapid A→B→A swaps must not show B's bars under A.
- A slow stale Supabase row must not replace a newer IndexedDB series.
- Auth sign-out must make the previous owner's cached symbols inaccessible.
- IndexedDB disabled or full must not block chart loading.
- Polling remains functional after an initial stale paint.

---

### Task 1: Persistent bar store

**Files:** Create `apps/web/src/features/investing/data/marketBarCache.ts` and its test.

- [ ] Write a failing test for owner/variant isolation, schema validation, bounded eviction, and unavailable IndexedDB.
- [ ] Run the focused test to verify the failure.
- [ ] Implement native IndexedDB reads, writes and owner-aware deletion with a bounded record count.
- [ ] Run focused tests and commit.

### Task 2: Saved-row first chart reads

**Files:** Modify `apps/web/src/features/investing/data/supabaseMarket.ts`, `apps/web/src/features/investing/chart/useCandles.ts`, and their tests.

- [ ] Write failing tests showing IndexedDB data and expired Supabase data before collector completion, then fresh replacement.
- [ ] Run focused tests to verify the failures.
- [ ] Publish initial saved data into the keyed React Query cache; keep refresh in flight and persist fresh results.
- [ ] Extend in-memory retention and verify variants and stale status.
- [ ] Run focused tests and commit.

### Task 3: Sign-out isolation and verification

**Files:** Modify `apps/web/src/app/providers/QueryProvider.tsx` and tests; update results documentation.

- [ ] Write a failing test for clearing bar cache when the authenticated owner changes or signs out.
- [ ] Run the focused test to verify the failure.
- [ ] Clear in-memory and persistent bars on auth boundary; leave other data untouched.
- [ ] Run web tests, typecheck, lint, formatting and build; review the diff.
- [ ] Open PR, wait for CI, merge and verify the deployed asset is accessible.

## Verification record

- Web tests: 2,357 passed, 2 skipped (173 files passed, 1 skipped) before the final ordering test. Focused post-review tests: 44 passed.
- Typecheck, lint, formatting and production build passed. Lint retains 11 warnings in unrelated files.
- A Chrome smoke test exercised native IndexedDB write, read, owner isolation and clear successfully.
- Review fixes: saved series use capture timestamps to prevent an older source, including an unexpired Supabase row, from replacing a newer one; memory retention lasts for the open page session.
- Before/after timing for authenticated asset swaps requires a signed-in production browser. The earlier Investing navigation trace showed `market_bars` at 239 ms and collector requests ending at 1,798 ms from page navigation; it is not an asset-swap benchmark. Record A→B→A, a return after five minutes, and a reload in production after merge.
- Remaining: PR, CI, merge, deployed-page verification and authenticated swap timing.
