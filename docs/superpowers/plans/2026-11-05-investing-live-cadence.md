# Investing Live Cadence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shorten live quote and focused Yahoo candle latency and measure the resulting local cadence.

**Architecture:** Keep the existing Pi streams and Supabase Broadcast path. Change the worker's publication cycle and the focused Yahoo fetch pause, with behavioral tests and a controlled timing probe.

**Tech Stack:** Python 3.12+, asyncio, pytest.

**Spec:** `docs/superpowers/specs/2026-11-05-investing-live-cadence-design.md`

## Global Constraints

- No production deployment or owner data mutation.
- Keep change-only broadcast batches and existing failure backoff.
- Compare baseline and branch measurements using the same probe.

## Review Focus

- A slow Supabase POST must not overlap another publication or drop the next tick.
- An idle market must not send empty broadcasts.
- Removing chart focus must stop Yahoo fetches.
- Yahoo errors must keep bounded backoff.
- Browser REST fallbacks remain independent from live publication.

---

### Task 1: Live quote publication

**Files:** `services/api/app/services/market_worker.py`, `services/api/tests/test_market_worker.py`

- [x] Add a behavior test showing a changed quote publishes within 400 ms.
- [x] Run the test and observe a timing failure at the 500 ms baseline.
- [x] Set the worker's live broadcast cycle to 250 ms.
- [x] Run the targeted worker tests.

### Task 2: Focused Yahoo candle

**Files:** `services/api/app/adapters/live_bars.py`, `services/api/tests/test_live_bars.py`

- [x] Change the existing behavior test to require a 2 s successful poll pause.
- [x] Run the test and observe the 5 s baseline failure.
- [x] Set the successful Yahoo poll pause to 2 s.
- [x] Run the targeted bar stream tests.

### Task 3: Measure and verify

**Files:** `work/investing_live_cadence_measure.py`, `docs/investing-live-cadence-measurements-2026-11-05.md`

- [x] Add a controlled probe for publication and Yahoo fetch intervals.
- [x] Measure the baseline and branch with the same probe, reporting sample sizes and limitations.
- [x] Run the API suite and relevant lint/type checks (full suite blocked by the installed MCP version; see report).
- [ ] Review the branch diff and commit the work.
