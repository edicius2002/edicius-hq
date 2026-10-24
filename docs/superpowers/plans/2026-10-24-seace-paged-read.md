# SEACE Paged Read Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Load only the requested SEACE result page while retaining all current explorer behavior.

**Architecture:** A PostgreSQL RPC owns view membership, exclusion, sorting, exact counting, and pagination. A trigger maintains indexed fields derived from source payload. The React page requests `{rows,total}` for its active controls and renders returned rows directly.

**Tech Stack:** PostgreSQL/Supabase, React, TypeScript, Vitest, pgTAP.

**Spec:** `docs/superpowers/specs/2026-10-24-seace-paged-read-design.md`

## Global Constraints

- Current collector upserts must continue to work without a new release.
- Existing controls and row content remain available.
- Never deploy the migration or web app as part of this local implementation.

## Review Focus

- A notice with a date-only end is closed after Lima midnight; a process date-only end stays open through that Lima day.
- A terminal process remains closed even if its end date is in the future.
- A result page emptied by exclusion still reports the correct total and page count.
- A stale response cannot replace results from newer filter settings.
- An authenticated user outside `edicius_owners` reads no records.

---

### Task 1: Database read contract

**Files:**

- Create: `supabase/migrations/20261024000000_seace_paged_read.sql`
- Create: `supabase/tests/seace_paged_read.sql`

**Interfaces:**

- Produces: `read_owner_seace_page(p_region,p_year,p_view,p_minor_only,p_object_filter,p_excluded,p_search,p_sort_field,p_ascending,p_page,p_page_size,p_now)` returning `{rows,total}` JSONB.

- [x] Write SQL tests for the four views, date boundaries, owner isolation, exclusions, search, sorting, and page 2.
- [x] Run the tests against an isolated PostgreSQL database and observe the missing RPC failure.
- [x] Add derived columns, their maintenance trigger, backfill, indexes, and the RPC.
- [x] Rerun SQL tests to green and inspect an `EXPLAIN` for the default view.

### Task 2: Web data and explorer

**Files:**

- Modify: `apps/web/src/features/seace/data.ts`
- Modify: `apps/web/src/features/seace/SeacePage.tsx`
- Modify: `apps/web/src/features/seace/data.test.ts`
- Modify: `apps/web/src/features/seace/SeacePage.test.tsx`
- Modify: `apps/web/src/shared/supabase/database.types.ts`

**Interfaces:**

- Consumes: `read_owner_seace_page` from Task 1.
- Produces: `loadSeacePage(query): Promise<{rows: SeaceRow[],total: number}>`.

- [x] Write failing data and UI tests proving a view loads only one page and that filters, count, and pagination request new results.
- [x] Run focused tests and observe the expected failures.
- [x] Implement the RPC adapter and replace the full download and client filtering with page state.
- [x] Run focused tests, typecheck, lint, build, and the complete web suite.

### Task 3: Operational verification

**Files:**

- Modify: `docs/seace-collector-runbook.md`

- [x] Document migration-before-web rollout and the browser timing method for postdeployment comparison.
- [x] Check the final diff, clean working tree scope, and all task results.
