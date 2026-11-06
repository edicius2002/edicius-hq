# Supabase Disk I/O Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for the SQL and validation;
> the independent Python caller change is delegated with a bounded file scope.

**Goal:** Reduce Airfare temporary I/O and repeated writes while preserving results.
**Architecture:** Forward SQL migration plus explicit incremental caller options.
**Tech Stack:** PostgreSQL 17, pgTAP, Python, pytest.
**Spec:** ../specs/2026-11-06-supabase-disk-io-design.md

## Global constraints

Preserve archive/replica authority, freshness, RLS, dirty locking, retries and all
November 1 availability semantics. No production deployment or global work_mem change.

## Review focus

- Equal timestamps/source positions must retain deterministic record/ordinal order.
- Unpriced and price-reverted observations must retain prior change semantics.
- No-offers, errors and restored availability must match the previous implementation.
- A no-upload sync must still drain dirty projection retries.
- Obsolete projections must disappear while unchanged rows avoid physical rewrites.

## Task 1: SQL regression and performance fixture

- [x] Add deterministic parity, obsolete-row and unchanged-row-version assertions.
- [x] Run against current migration; record the unchanged-row failure.
- [x] Capture baseline temporary blocks, WAL, elapsed time on synthetic history.

## Task 2: Projection implementation

- [x] Add `20261106000000_airfare_projection_io.sql` replacing the month function.
- [x] Use scalar event references and deterministic earliest priced selection.
- [x] Replace wholesale delete/insert with changed-only upsert and obsolete-key delete.
- [x] Run semantic SQL tests and benchmark; record actual improvement.

## Task 3: Incremental manifest callers

- [x] Add failing collector/CLI tests for omitting routine manifests.
- [x] Change callers, retain full apply/verify and dirty projection retries.
- [x] Update synchronization contract and run Python regression tests.

## Task 4: Review and branch delivery

- [x] Run relevant full suites, formatting and type checks.
- [x] Independent review of final diff; resolve substantive findings.
- [x] Record write inventory, evidence, measurements, deployment steps and limitations.
- [x] Commit on `fix/supabase-disk-io`; leave production unchanged.

## Execution record

- Branch created from origin/main (7f41880); prior Investing branch retained.
- Existing Python venv points at a missing Python 3.12 install; available interpreter
  is Python 3.13.13. Use an external temporary test directory for privacy-label tests.
- Isolated PostgreSQL container: `edicius-io-test-20261106`, no network or published ports.

- SQL RED: the original function rewrote both unchanged rows (ctid mismatch).
- Python RED: two new HTTP-boundary tests detected unwanted routine manifest calls.
- SQL GREEN: 24 files, 662 assertions and the manifest catalog check. The test-only
  Auth fixture adds email_confirmed_at and both JWT claim forms; Realtime policies
  use minimal message/topic interfaces, not a running Realtime service.
- Python GREEN with pinned requirements in a new local venv: 1,485 passed,
  28 skipped, six existing deprecation warnings. The initial system environment
  failed SEACE tests because it had MCP 1.x; installing required MCP 2.3.0 resolved it.
- Ruff lint/format pass; mypy passes 96 source files; changed Markdown formatted.
- Final local benchmark medians: temporary written blocks 16,010 -> 4,222;
  temporary read blocks 15,238 -> 3,460; WAL 1,820,502 -> 90,733 bytes;
  elapsed 344.341 -> 265.982 ms. Complete month and flight result parity passed.
  Earlier timing samples varied under local load; only the workload-specific I/O
  reductions are treated as robust evidence, not a production savings guarantee.
- Review: no blocking findings. Added equal-time/equal-position record-ID ties and
  mixed changed/unchanged row-version assertions in response to test-gap feedback.
- Ruling: correct the existing SEACE has_column invocation to the explicit four-argument
  overload after observing its false failure on an existing column; no product change.
- Ruling: keep the regression SQL stdin-compatible with the existing runner; legacy
  implementation inclusion and complete output parity stay in the opt-in benchmark.
- No production deployment, push, merge, archive cleanup, or scheduling changes.
