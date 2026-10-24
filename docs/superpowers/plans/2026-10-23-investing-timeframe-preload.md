# Investing Timeframe Preload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make timeframe changes paint from preloaded history and reduce the wait for completed collector results.

**Architecture:** The visible chart and a one-at-a-time prefetch loop use one chart query loader and the existing owner-scoped caches. The request transport reconciles quickly at first and returns to its slower cadence after eight seconds.

**Tech Stack:** React 19, TanStack Query 5, Vitest, Supabase JS.

**Spec:** `docs/superpowers/specs/2026-10-23-investing-timeframe-preload-design.md`

## Global Constraints

- Preserve `(symbol, timeframe, extended)` query identity, owner isolation, cancellation, stale painting, and the 90-second request deadline.
- Limit prefetch to one in-flight sibling for the selected symbol; the visible chart remains first, each speculative wait is bounded to twelve seconds, and speculative memory retention is 30 minutes.
- Do not overwrite unrelated uncommitted changes in this shared checkout.

## Review Focus

- Rapid symbol changes must not store old-series data under the new symbol.
- Clicking the sibling currently loading must reuse its query; clicking a different sibling must cancel unobserved speculative work.
- A cached sibling must not enqueue another request while fresh; a saved stale sibling must keep its original capture time after refresh failure.
- A failed or stalled sibling must not prevent the remaining frames from warming.
- A disconnected Realtime channel must still deliver a completed result promptly through HTTP.

---

### Task 1: Shared chart loader and sibling prefetch

**Files:** `apps/web/src/features/investing/chart/useCandles.ts`, `apps/web/src/features/investing/chart/useCandles.test.tsx`

**Interfaces:** Produce a shared loader for the visible query and `prefetchQuery`; no public API change.

- [x] Add failing hook tests for background warming, sequential requests, cache reuse on selection, failure continuation, and cancellation on symbol change.
- [x] Run the hook test file and confirm the new cases fail for missing prefetch behavior.
- [x] Extract the existing query function and schedule six sibling queries with bounded sequential work.
- [x] Run the hook tests and TypeScript; confirm the new cases pass.

### Task 2: Fast initial collector reconciliation

**Files:** `apps/web/src/features/investing/data/supabaseMarket.ts`, `apps/web/src/features/investing/data/supabaseMarket.test.ts`

**Interfaces:** The transport still resolves the existing `getBars` promise; its initial HTTP check interval is 750 ms for eight seconds, then 2 s.

- [x] Add a failing fake-clock transport test for completion shortly after the initial HTTP check, including fallback when Realtime sends no update.
- [x] Run that test and confirm it fails on the current 2-second interval.
- [x] Implement the adaptive reconciliation cadence and cleanup.
- [x] Run transport tests, then all Investing tests and TypeScript.

### Task 3: Final review and measurement handoff

**Files:** only files from Tasks 1–2 and this plan.

- [x] Inspect the final diff for query identity, abort behavior, bounded traffic, and unrelated edits.
- [x] Run focused and full web verification plus `git diff --check`.
- [x] Report the measured pre-change baseline and the deployment verification still needed; do not claim a production speedup without a deployment measurement.

Verification: 59 focused transport/chart tests passed; the full web suite passed with 2,575 tests and 2 skipped. TypeScript, targeted ESLint, Prettier, and `git diff --check` passed. Production timings remain the pre-change baseline because this checkout has unrelated uncommitted work and was not deployed.
