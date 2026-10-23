# SEACE Last Fetch Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual refresh button beside Region with a compact two-line indicator showing new records and the last fetch time.

**Architecture:** Persist the collector's existing `added` count in `seace_sync_state`, then read the latest sync state for the selected region and year. Preserve legacy sync rows as an unknown count until their next fetch. Keep the toolbar 42px high and let the region/status pair span the mobile filter grid.

**Tech Stack:** Python collector, Supabase SQL/PostgREST, React/TypeScript, CSS modules, pytest, Vitest.

**Spec:** User request in this conversation, 2026-10-23.

## Global Constraints

- Keep the current region selector and automatic data loading when the region changes.
- Remove the manual refresh button and its unused browser-side queue/poll flow.
- Show exactly two small-text lines beside Region: centered new count, then Peru day/month and time without the year.
- Never present cumulative record count or updated rows as newly added records.

## Review Focus

- Existing sync rows have no new count: show an unknown marker.
- Multiple source kinds share a fetch timestamp: sum their added counts.
- A newer partial source timestamp must not include older source counts.
- A missing database migration must still allow the records table to load.
- Mobile widths must keep selector and status legible at the toolbar height.

---

### Task 1: Persist actual added counts

**Files:** `supabase/migrations/20261023020000_seace_sync_new_count.sql`, `services/seace/incremental.py`, `services/seace/publish.py`, `scripts/seace-collect.py`, `services/api/tests/test_seace_publish.py`.

- [x] Add a failing publisher test for `new_count`.
- [x] Run the focused pytest and confirm the failure.
- [x] Add the nullable column and pass `added` from merge to publisher.
- [x] Run the focused pytest and confirm success.

### Task 2: Read and render the indicator

**Files:** `apps/web/src/features/seace/data.ts`, `apps/web/src/features/seace/SeacePage.tsx`, `apps/web/src/features/seace/SeacePage.module.css`, `apps/web/src/features/seace/SeacePage.test.tsx`, `apps/web/src/shared/supabase/database.types.ts`.

- [x] Add a failing UI test for the two-line count/date and removed refresh control.
- [x] Run the focused Vitest and confirm the failure.
- [x] Load sync state with a legacy fallback; render the latest fetch and sum new counts.
- [x] Style the 42px region/status pair for desktop and mobile.
- [x] Run focused tests, build, diff check, and inspect the local preview.
