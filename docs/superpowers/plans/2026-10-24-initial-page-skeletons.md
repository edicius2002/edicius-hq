# Initial Page Skeletons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every app page a layout-matched skeleton during its first route and data load while preserving cached content during refreshes.

**Architecture:** A shared page skeleton component provides route fallback templates and page-level initial placeholders. Individual pages use their own query states to show placeholders only where data is absent. Airfare and SEACE retain their existing data skeletons.

**Tech Stack:** React 19, TypeScript, React Router 7, TanStack Query 5, CSS modules, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-24-initial-page-skeletons-design.md`

## Global Constraints

- Keep cached data visible on later refreshes.
- Keep errors and completed empty states distinct from loading.
- Loading shapes use the existing `Skeleton` component and remain inaccessible and noninteractive.

## Review Focus

- A lazy route and a pending data request must show the same page shape.
- Cached data remains visible while a query refetches.
- Concurrent dashboard and investing regions resolve independently.
- Failed and empty requests do not remain skeletons.
- Narrow viewports show no horizontal overflow from skeleton templates.

---

### Task 1: Shared page templates and route fallback

**Files:** Create `apps/web/src/shared/ui/PageSkeleton.tsx`, `PageSkeleton.module.css`, `PageSkeleton.test.tsx`; modify `apps/web/src/app/layout/AppShell.tsx`, `apps/web/src/app/App.tsx`.

- [x] Write tests for each route's template, accessibility status, auth checking, and the route fallback.
- [x] Run focused tests and confirm feature-related failures.
- [x] Implement templates using `Skeleton`, then replace the generic Suspense and auth checking blanks.
- [x] Run focused tests and confirm passes.

### Task 2: Initial data placeholders

**Files:** Modify Dashboard, Finance, Greenlight, Investing, Sentiment pages and relevant hooks; modify or add their tests.

- [x] Write focused tests showing initial placeholders and retained cached data on refresh.
- [x] Run tests and confirm feature-related failures.
- [x] Expose a true initial-pending state where hooks currently expose only fetching; render skeletons in the absent data regions.
- [x] Run focused tests and confirm passes.

### Task 3: Verification

- [x] Run the complete web test suite, typecheck, lint, formatting check, and production build.
- [x] Inspect the diff against the spec and correct any gaps.

### Task 4: Match each visualization

- [x] Test that each route renders the silhouette of its actual visualization or data structure.
- [x] Replace generic cards with chart, calendar, canvas, map, table, and list shapes.
- [x] Make Investing watchlist, position, and alert rows distinct.
- [x] Match the in-page candle, FX history, and position placeholders to the loaded chart and card geometry.
- [x] Inspect desktop and mobile layouts in the browser and correct mismatches.
