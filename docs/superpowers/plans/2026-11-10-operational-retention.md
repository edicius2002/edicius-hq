# Operational Data Retention Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Bound operational Supabase history without deleting the Airfare archive, derived reads, or active requests.

**Architecture:** Routine Airfare sync persists a compact source summary while keeping the full in-memory report and full explicit verification. A privileged, bounded database RPC prunes only terminal operational rows older than seven days. A Pi timer calls the RPC daily, with dry-run as the CLI default.

**Tech Stack:** PostgreSQL 17, Supabase Data API, Python, pytest, pgTAP, systemd.

**Spec:** [Operational retention](../../operational-retention.md).

## Global Constraints

- Do not delete `fare_snapshots`, `fare_baseline_points`, `fare_checks`, projections, or `market_bars`.
- Do not grant direct DELETE on either operational table to browser or service roles.
- Do not apply the migration or run the Pi job in production from this branch.
- Use fixed seven-day retention and batches of at most 500 rows per table.

## Review Focus

- Active and recently terminal requests must remain readable.
- Running imports must remain untouched, including stale-looking rows.
- Browser roles must not execute the maintenance RPC.
- An interrupted cleanup must resume safely on the next call.
- Pi install must not start or enable the timer; release and rollback must track it.

### Task 1: Compact routine manifests

- [x] Add a failing Airfare sync test for persisted summary and intact report/full mode.
- [x] Implement compact persisted source manifest for unscoped incremental sync.
- [x] Run targeted Python tests.

### Task 2: Bounded database retention

- [x] Add pgTAP coverage for dry-run, age/status gates, batch limit, role grants, and idempotence.
- [x] Add a forward SQL migration with a privileged retention RPC.
- [ ] Run local SQL tests (local Docker daemon unavailable; run before migration rollout).

### Task 3: Pi maintenance job

- [x] Add tests for safe dry-run and apply, bounded loop, and packaged timer.
- [x] Add the Python command, systemd units, installer, verifier, and release lifecycle.
- [x] Run targeted Python and Pi tests.

### Task 4: Review and verification

- [x] Document measured candidate rows, rollout order, and physical-space caveat.
- [x] Run required checks, inspect diff, and commit the branch.

Verification note: 1,544 Python/Pi tests passed with two unrelated SEACE
modules excluded. Those modules require `mcp.server.mcpserver`, which is absent
from the local MCP installation. The local SQL test remains pending because the
Docker daemon is unavailable.
