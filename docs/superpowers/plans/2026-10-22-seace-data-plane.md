# SEACE Data Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run incremental SEACE collection on bodas and store searchable procurement records in the existing edicius-hq Supabase project.

**Architecture:** Add owner-scoped SEACE records, sync checkpoints, and reversible exclusions to `public`; reuse the existing collector request queue for manual refresh. A Pi one-shot service uses the locally extended SEACE MCP, writes changed rows to Supabase before advancing its local checkpoint, and a timer starts scheduled passes. The web prototype can read the same records through Supabase Auth without receiving the service key.

**Tech Stack:** PostgreSQL/Supabase RLS, Python 3.13, MCP stdio, systemd, existing HTML/JS prototype.

**Spec:** The conversation through 2026-10-22: Arequipa default, minor contracts, three notice views plus published contracts, per-view exclusions, manual and automated incremental fetch.

## Global Constraints

- Do not modify existing Edicius data tables or the user's dirty checkout.
- Pi is the only provider-facing collector; service-role credential stays in `/etc/edicius-hq/collectors.env`.
- Never wipe or truncate records on refresh. Exclusions survive source updates.
- Source labels and values remain untranslated; user interface controls use English.

## Review Focus

- A failed partial upload must not advance a checkpoint; retry must be idempotent.
- A slow refresh must not overlap a scheduled pass or another manual pass.
- Authenticated users outside `edicius_owners` must read zero SEACE rows and cannot enqueue.
- Existing market/airfare workers must never claim SEACE jobs.
- Regions and years must be validated before a manual request reaches the Pi.

---

### Task 1: Add isolated Supabase schema and owner access

**Files:** Create `supabase/migrations/20261022000000_seace_data_plane.sql`; create `supabase/tests/seace_data_plane.sql`.

**Interfaces:** `seace_records`, `seace_sync_state`, `seace_exclusions`; `enqueue_seace_refresh(region, year)`; extend `claim_collector_request` operations to `seace-refresh`.

- [ ] Write SQL assertions for owner RLS, reversible exclusions, queue validation, and deduplication.
- [ ] Run DB tests and verify the assertions fail before the migration.
- [ ] Implement additive schema and RPC changes.
- [ ] Run DB tests and verify pass.

### Task 2: Add Pi collector and MCP source

**Files:** Add `services/seace/` source, `scripts/seace-collect.py`, focused Python tests, systemd service/timer; modify Python dependency list and installer.

**Interfaces:** One command performs one region/year pass; service role upserts only changed records, then sync state, then local checkpoint. Request worker claims only `seace-refresh` jobs.

- [ ] Write tests for stable keys, retries, checkpoints, and request validation.
- [ ] Run tests to verify the new cases fail.
- [ ] Implement and wire the collector, request worker, and systemd units.
- [ ] Run focused tests and lint.

### Task 3: Connect the Edicius HQ web app to Supabase

**Files:** Add `apps/web/src/features/seace/`; extend the route table, navigation, and Supabase types.

**Interfaces:** Read region pages and exclusions from owner-gated Supabase data. Manual refresh queues a Pi job and reports its status.

- [x] Write tests for recent/open separation and reversible exclusions.
- [x] Implement paginated Supabase reads, manual queue, and the four views.
- [ ] Verify the four views with real Arequipa records after the initial Pi pass.

### Task 4: Stage and verify remote deployment

**Files:** Document migration, Pi installation, smoke check and rollback in `docs/seace-collector-runbook.md`.

- [ ] Verify linked Supabase migration state and preview additive SQL.
- [ ] Deploy migration and one-shot collector only after tests and a pinned release are ready.
- [ ] Check a real Arequipa incremental pass, Supabase row counts, and unchanged existing units.
- [ ] Enable the timer after the one-shot passes.
