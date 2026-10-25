# FX Collector Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve five-minute FX acquisition across daylight-saving changes and make per-source failures and stale skips observable.

**Architecture:** Use a UTC calendar timer, safe provider error metadata, and an in-place SQLite source-health table alongside the existing due/outbox tables. The collector uses local health to choose one fast Kambista retry and to mark stale skipped sources in its existing run result.

**Tech Stack:** systemd timer, Python 3.12/3.13, SQLite, httpx, pytest.

**Spec:** `docs/superpowers/specs/2026-10-25-fx-reliability-design.md`

## Global Constraints

- Do not store or log upstream bodies, cookies, credentials or request payloads.
- Keep the existing local outbox and Supabase `fx_observations` contract intact.
- Support old Pi SQLite files by creating additive local tables only.

## Review Focus

- The repeated Europe/London hour must not skip UTC slots.
- A 200 HTML challenge must be classified without leaking its body.
- BCRP and SBS must continue sharing one upstream request and receive the same safe error.
- A skipped source past its freshness threshold must make the pass unhealthy once, without inventing a new capture.
- Explicit rate-limit or forbidden delays must not be shortened by Kambista's first malformed-response retry.

---

### Task 1: UTC timer

**Files:** `ops/pi/systemd/edicius-fx.timer`, `ops/pi/tests/test_fx_lifecycle.py`

- [x] Add a regression test that runs `systemd-analyze calendar` across the fallback boundary where available, asserting the next elapse is 01:00 UTC.
- [x] Run the test red, update `OnCalendar` with an explicit UTC zone, then run it green.

### Task 2: Provider diagnostics

**Files:** `services/api/app/services/fx/providers.py`, `services/api/tests/test_fx_providers.py`

- [x] Add tests for a 200 challenge, invalid JSON, missing Kambista quote and rate validation, asserting safe codes and bounded metadata.
- [x] Run red; implement stage-aware `ProviderError` metadata and safe logging; run green.

### Task 3: Local health and retry

**Files:** `services/api/app/services/fx/store.py`, `services/api/app/services/fx/collector.py`, `scripts/fx-collect.py`, `services/api/tests/test_fx_collector.py`

- [x] Test in-place SQLite upgrade, success/failure persistence, first Kambista retry, later backoff and stale skipped sources.
- [x] Run red; implement the smallest state and collector changes; run green.
- [x] Add a read-only operator status command and test its output without printing private rows.

### Task 4: Verification and rollout

**Files:** `docs/pi-collectors-runbook.md`

- [x] Document the UTC timer and source-health check.
- [x] Run focused FX tests, full Python suite and systemd calendar verification.
- [ ] Inspect the diff, deploy with the pinned release launcher if access permits, and verify the active timer and first completed pass.
