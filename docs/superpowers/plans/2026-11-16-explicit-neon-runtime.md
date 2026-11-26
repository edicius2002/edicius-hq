# Explicit Neon Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Prevent silent Supabase selection during normal startup and make Neon the documented explicit configuration.

**Architecture:** Validate backend selectors at their entry points before creating clients. Keep rollback paths callable only with explicit values. Update deployment validation and example configuration to match.

**Tech Stack:** React/Vite, FastAPI/Python, Bash, pytest, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-16-explicit-neon-runtime-design.md`

## Global Constraints

- Do not print or commit connection secrets.
- Preserve the Pi's local Airfare archive as its authoritative source.
- Keep historical Supabase import files for audit and explicit rollback.

## Review Focus

- A missing selector must fail before any remote connection.
- An unknown selector must fail with the variable name.
- Explicit Neon must not initialize Supabase Auth or Realtime.
- Explicit rollback to Supabase must remain deliberate and testable.
- Pi validation must require Neon `DATABASE_URL` when selected.

---

### Task 1: Browser selector

- [x] Add a failing Vitest case for absent and unknown `VITE_DATA_BACKEND`.
- [x] Require `neon` or `supabase` in the shared selector and retain the Neon trial override.
- [x] Set explicit browser selector in test setup and verify focused tests.

### Task 2: Python runtime selectors

- [x] Add failing pytest cases for absent API, collector, and Airfare sync selectors.
- [x] Remove silent Supabase defaults in config and workers; share the collector selector.
- [x] Verify focused API tests.

### Task 3: Pi validation and configuration

- [x] Update Pi validation tests to require selectors.
- [x] Require selectors in install, verify, smoke, and check scripts.
- [x] Document explicit Neon values and remove ordinary Supabase importer commands.
- [x] Run Pi tests, typecheck, and final default audit.
