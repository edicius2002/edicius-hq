# Airfare Paired Rows and Month Fetch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pair consecutive watched routes per row and show independent route-month Fetch progress in the row action.

**Architecture:** Keep the queue's request ID as the transport identity while deriving a route-month UI key from each payload. Reuse route groups for reciprocal switching, then pair consecutive groups only for presentation. Extend manual sync with a progress callback that reports completed work units through the queue's existing `{stage, completed, total}` shape.

**Tech Stack:** React, TypeScript, CSS Modules, Vitest, Python, pytest, Supabase request queue.

**Spec:** `docs/superpowers/specs/2026-10-24-airfare-paired-rows-month-fetch-design.md`

## Global Constraints

- Preserve reciprocal direction switching and selection behavior.
- Never enqueue an active route-month twice; allow other months of that route.
- Remove deletes the selected route, including all watched months.
- Never show a fabricated percentage when the backend has no denominator.
- Keep terminal notices and accessible route/month names.

## Review Focus

- Two requests for different months of one route retain separate progress; tested in Task 1.
- A second click before the enqueue response cannot duplicate a route-month; tested in Task 1.
- An odd final row retains working actions; tested in Task 3.
- Reciprocal directions remain one clickable route cell; tested in Task 3.
- Sync failure never displays a completed request; tested in Task 2.

---

### Task 1: Route-month request state

**Files:** `apps/web/src/features/airfare/hooks/useRouteCollection.ts`, `apps/web/src/features/airfare/hooks/useRouteCollection.test.tsx`, `apps/web/src/features/airfare/lib/passProgress.ts`, `apps/web/src/features/airfare/AirfarePage.tsx`

**Interfaces:** `routeMonthKey(route, month): string`; `RouteCollection.collecting` and `.progress` keyed by route-month; `RouteCollection.collect` suppresses duplicate pending/active requests and exposes `queued`, `collecting`, and `syncing` progress.

- [ ] Write tests for independent months, duplicate suppression before/after enqueue, and stage-specific progress.
- [ ] Run focused Vitest and verify the new tests fail for the expected behavior.
- [ ] Implement route-month keys, pending request handling, and stage-specific progress mapping.
- [ ] Run focused Vitest and typecheck to verify the tests pass.

### Task 2: Real sync percentage

**Files:** `services/api/app/services/airfare_sync.py`, `services/api/app/services/airfare_data.py`, `services/api/app/services/airfare_request_worker.py`, related Python tests.

**Interfaces:** `AirfareData.sync_manual_route(origin, destination, on_progress=None)` forwards a `(completed, total)` callback; manual sync reports completed upload and finalization units; worker publishes them under `stage='syncing'`.

- [ ] Write tests for monotonic sync progress, completion at 100%, and failure staying below completion.
- [ ] Run focused pytest and verify the new tests fail for the expected behavior.
- [ ] Implement sync work-unit reporting and worker queue updates.
- [ ] Run focused pytest and Python lint/type checks relevant to the changed files.

### Task 3: Paired route rows and Fetch action

**Files:** `apps/web/src/features/airfare/ui/RouteList.tsx`, `apps/web/src/features/airfare/ui/RouteList.module.css`, `apps/web/src/features/airfare/ui/RouteList.test.tsx`, `apps/web/src/features/airfare/ui/RouteListCollection.test.tsx`, `apps/web/src/features/airfare/ui/routesScroll.test.ts`

**Interfaces:** Each `li` renders two consecutive route groups, their month controls, and a shared Fetch/Remove action for the selected route-month in that row. Busy action shows `↓ n%` or `↑ n%`; no below-row bar.

- [ ] Write tests for two-route rows, odd rows, reciprocal switches, target selection, independent months, and in-button progress.
- [ ] Run focused Vitest and verify the new tests fail for the expected behavior.
- [ ] Implement paired rendering and responsive CSS; remove the old bar markup and styles.
- [ ] Run focused Vitest and typecheck to verify the tests pass.

### Task 4: Integration and branch

**Files:** Any tests needing contract updates; no new product behavior.

- [ ] Run the relevant web and Python suites, formatting, type checks, and diff checks.
- [ ] Review the browser at desktop and narrow widths, including two simultaneous months.
- [ ] Commit the verified changes on `feat/airfare-two-routes-month-fetch-20261024`.
