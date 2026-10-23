# SEACE prod6 Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Space the starts of prod6 HTTP attempts by one second across all MCP tools while retaining the five-request concurrency ceiling.

**Architecture:** Add one event-loop-local pacing lock and next-start timestamp beside the existing prod6 semaphore in the vendored transport. Acquire capacity, wait for the next start slot, then issue HTTP. Make the interval configurable with a validated environment variable. The existing queue and retry policy remain unchanged.

**Tech Stack:** Python asyncio, httpx, pytest.

**Spec:** docs/seace-prod6-cadence-analysis.md

## Global Constraints

- Default start interval is 1.0 second per MCP process; zero is allowed for targeted tests or rollback.
- Preserve the default maximum of five simultaneous prod6 HTTP requests.
- Apply pacing to search, detail, files, and each HTTP retry.
- Do not log full IDs, URLs, bodies, headers, or credentials.

## Review Focus

- Concurrent tool calls share one pacing gate.
- A cancelled waiter does not consume a future start slot.
- Slow HTTP responses may overlap up to the existing concurrency ceiling.
- Long Retry-After remains durable and is not shortened by pacing.
- Invalid interval values fail at startup.

---

### Task 1: Shared prod6 start pacing

**Files:** Modify services/seace/vendor/seace_mcp/server.py and services/api/tests/test_seace_transport.py; update docs/seace-transport-control.md.

**Interfaces:** SEACE_PROD6_MIN_INTERVAL_SECONDS configures seconds between request starts; api6_json applies it across all callers.

- [x] Add a test with simultaneous prod6 callers that records HTTP start times and fails when adjacent starts are too close.
- [x] Run the test and confirm it fails against the current transport.
- [x] Implement the shared pacing lock and validated interval.
- [x] Run targeted transport and collector tests, then lints and type checks.
- [x] Commit, publish, deploy the exact commit, and inspect a real pass for 403 and start spacing.
