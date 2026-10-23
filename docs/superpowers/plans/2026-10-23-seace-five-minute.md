# SEACE Five-Minute Notice Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh Arequipa minor notices every five minutes while leaving processes and published contracts hourly, and pause prod6 after a 403.

**Architecture:** Add a source scope to the existing collector and a dedicated notices systemd timer. Reuse the durable queue for new or changed open notices. Persist a prod6 cooldown beside queue state so later MCP processes honor it.

**Tech Stack:** Python 3.13, pytest, MCP, SQLite queue, systemd on Raspberry Pi.

**Spec:** `docs/superpowers/specs/2026-10-23-seace-five-minute-design.md`

## Global Constraints

- Keep `SEACE_PROD6_MIN_INTERVAL_SECONDS` defaulting to one second and `SEACE_PROD6_MAX_CONCURRENCY` defaulting to five.
- Preserve region/year source checkpoints and previously fetched notice items/documents.
- The manual refresh remains a three-source pass.

## Review Focus

- First run without snapshots still discovers the selected source.
- A selected-source failure never advances another source checkpoint.
- A 403 during a batch starts one cooldown and prevents queued HTTP attempts.
- Cooldown survives MCP restart and expires without manual intervention.
- An old closed notice does not join the five-minute detail backlog.

---

### Task 1: Source-scoped collection

**Files:** `services/seace/incremental.py`, `scripts/seace-collect.py`, `services/api/tests/test_seace_pending.py`, `services/api/tests/test_seace_collect_command.py`.

**Interfaces:** `refresh_region(..., kinds=(...))`; scheduled CLI `--scope notices|core|all`, manual scope fixed to all.

- [ ] Write tests for notice-only, core-only, manual-all and failure checkpoint isolation; verify red.
- [ ] Implement selected-source reads, fetches, publishes and writes; verify green.

### Task 2: New and changed notice enrichment

**Files:** `services/seace/refresh.py`, `services/api/tests/test_seace_pending.py`.

**Interfaces:** `PendingNotices.discover` reenrolls complete phases for a changed, still-open source row; `enrich` uses a bounded per-pass ID budget.

- [ ] Write tests for changed open, unchanged open, closed transition and bounded pending work; verify red.
- [ ] Implement queue enrollment and bounded selection; verify green.

### Task 3: Persistent prod6 cooldown

**Files:** `services/seace/vendor/seace_mcp/server.py`, `services/api/tests/test_seace_transport.py`, `scripts/seace-collect.py`, `services/api/tests/test_seace_collect_command.py`.

**Interfaces:** `SEACE_PROD6_403_COOLDOWN_SECONDS` defaults to 900; a state file contains only an epoch deadline; scheduled notice passes skip while it is active.

- [ ] Write transport and command tests for first 403, queued calls, restart and expiry; verify red.
- [ ] Implement durable cooldown and pass skipping; verify green.

### Task 4: Pi timers and rollout

**Files:** `ops/pi/systemd/edicius-seace-notices.{service,timer}`, `ops/pi/systemd/edicius-seace-scheduled.service`, `ops/pi/install.sh`, `ops/pi/verify.sh`, `ops/pi/deploy-release.sh`, `ops/pi/tests/test_units.py`, `docs/seace-collector-runbook.md`.

- [ ] Write unit-package tests for five-minute notices, hourly core and deploy lifecycle; verify red.
- [ ] Add units, installer/verification/deploy wiring, and runbook; verify green.
- [ ] Run the full API and Pi suites, lint, typecheck, and diff check; commit and publish.
- [ ] Deploy the exact commit to `bodas`; verify both timers, active release, request pacing and source-specific checkpoints.
