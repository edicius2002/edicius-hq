# Task 11 Production Safety Repairs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the production-safety blockers found before the Raspberry Pi collector cutover.

**Architecture:** Keep the existing owner-scoped collector data plane and add an advancing heartbeat to each long-running run. Add bounded one-shot modes and operational gates around the existing workers, then make the Windows/Pi handoff and release identity fail closed.

**Tech Stack:** PostgreSQL/Supabase pgTAP, Python 3.12/3.13 with pytest and httpx, Bash/systemd, PowerShell ScheduledTasks, Git.

**Spec:** `docs/superpowers/specs/2026-09-18-task11-production-safety-repairs-design.md`

## Global Constraints

- All schema changes are additive; never delete or truncate production rows.
- Never print or pass secrets in arguments; load them only from the protected environment file.
- Systemd units remain disabled until the sequential cutover.
- Sentiment, X, Market, then Airfare is the only allowed cutover order.
- PC data and rollback remain intact for at least seven days.
- Task 12 is out of scope.

---

### Task 1: Heartbeat and request-expiry schema

**Files:**

- Modify: `supabase/migrations/20260918000000_collector_data_plane.sql`
- Modify: `supabase/tests/collector_data_plane.sql`

**Interfaces:**

- Produces: `collector_runs.heartbeat_at timestamptz NOT NULL`.
- Produces: `claim_collector_request(uuid)` expires stale queued and running requests before claiming.

- [ ] **Step 1: Write failing pgTAP assertions**

Insert a running collector row and assert `heartbeat_at` defaults to its start time. Insert an already-expired running request, invoke `claim_collector_request`, and assert its status becomes `expired` with `completed_at` set.

- [ ] **Step 2: Run the database suite and confirm RED**

Run: `npx supabase test db`

Expected: the new heartbeat-column and stale-running assertions fail.

- [ ] **Step 3: Implement the additive schema behavior**

Add `heartbeat_at timestamptz not null default now()` to `collector_runs` and a constraint that it is not earlier than `started_at`. In `claim_collector_request`, expire `status in ('queued', 'running')` rows before selecting the next queued row.

- [ ] **Step 4: Reset and verify GREEN**

Run: `npx supabase db reset` and `npx supabase test db`.

Expected: all migrations apply and all pgTAP files pass.

- [ ] **Step 5: Commit**

Commit message: `fix: expire collector work and track heartbeats`.

### Task 2: Long-running worker heartbeat lifecycle

**Files:**

- Modify: `services/api/app/services/collector_cloud.py`
- Modify: `services/api/app/services/market_worker.py`
- Modify: `scripts/market-worker.py`
- Modify: `scripts/tweets-watch.py`
- Modify: `services/api/tests/test_collector_cloud.py`
- Modify: `services/api/tests/test_market_worker.py`
- Modify: `services/api/tests/test_market_worker_command.py`
- Modify: `services/api/tests/test_tweets_watch_command.py`

**Interfaces:**

- Produces: `CollectorCloud.heartbeat_run(run_id: UUID, records: Mapping[str, int]) -> None`.
- Produces: an optional Market reconciliation callback invoked after each successful full cycle.
- Produces: an X pass monitor that heartbeats only a finished, cloud-replayed pass.

- [ ] **Step 1: Add failing boundary and lifecycle tests**

Assert heartbeat updates include owner, `status=eq.running`, timestamp, and cumulative record counts. Assert X does not heartbeat on failed capture/replay and does heartbeat after a zero-new-post successful pass. Assert Market heartbeats only after request drain, quote recovery, and flush complete.

- [ ] **Step 2: Run focused tests and confirm RED**

Run the four affected pytest files with `services/api/.venv/Scripts/python.exe -m pytest ... -q`.

- [ ] **Step 3: Implement minimal heartbeat behavior**

Add the allowlisted update method. Expose a `cycle_completed` callback in `MarketWorker.run`, invoked after `flush_quotes`; the command passes a callback that writes cumulative `run_records`. In the X command, observe each completed watcher pass and write cumulative counts only when its state is `finished` after replica synchronization.

- [ ] **Step 4: Run focused tests and API suite**

Run focused tests, then `npm run api:test`.

Expected: all pass and existing terminal run semantics remain unchanged.

- [ ] **Step 5: Commit**

Commit message: `fix: heartbeat long-running collector work`.

### Task 3: One-shot X and Market verification

**Files:**

- Modify: `scripts/tweets-watch.py`
- Modify: `scripts/market-worker.py`
- Create: `ops/pi/smoke-collector.py`
- Modify: `ops/pi/verify.sh`
- Modify: `ops/pi/check-collector-run.py`
- Modify: `ops/pi/tests/test_runbooks.py`
- Modify: `services/api/tests/test_market_worker_command.py`
- Modify: `services/api/tests/test_tweets_watch_command.py`

**Interfaces:**

- Produces: `tweets-watch.py --once` that performs one capture/replay/run and exits.
- Produces: `market-worker.py --once` that completes one bounded reconciliation and exits.
- Produces: `smoke-collector.py {x-posts,market} --cutoff ISO8601` that validates owner-scoped rows/results without revealing payloads or secrets.
- Produces: `verify.sh --live <sentiment|x-posts|market>` with units required disabled.

- [ ] **Step 1: Add failing CLI and sanitization tests**

Test exact-one-cycle exits, failed provider/cloud exits, required cutoff validation, market quote/bar/search result checks, X post/heartbeat checks, environment-file security, disabled-unit checks, and output that contains only sanitized IDs/counts/timestamps.

- [ ] **Step 2: Run focused tests and confirm RED**

Run `pytest ops/pi/tests/test_runbooks.py` plus both command test files.

- [ ] **Step 3: Implement bounded modes and smoke helper**

Reuse existing workers rather than duplicating provider logic. The helper loads the root-owned `0600` environment exactly like `check-collector-run.py`, creates deterministic owner-scoped market smoke requests through the service-role boundary, waits no longer than their expiry, and validates result shapes without printing result payloads.

- [ ] **Step 4: Run focused and operations tests**

Run the focused files and `pytest ops/pi/tests -q`.

- [ ] **Step 5: Commit**

Commit message: `feat: verify Pi collectors with bounded live smokes`.

### Task 4: Immutable release and single-process ownership

**Files:**

- Modify: `ops/pi/install.sh`
- Modify: `ops/pi/verify.sh`
- Modify: `ops/pi/systemd/edicius-tweets.service`
- Modify: `ops/pi/systemd/edicius-market.service`
- Modify: `ops/pi/tests/test_units.py`
- Modify: `ops/pi/tests/test_runbooks.py`

**Interfaces:**

- Produces: install/verify failure whenever `git status --porcelain --untracked-files=all` is nonempty.
- Produces: nonblocking X and Market lock files under `/var/lib/edicius-hq/locks`.

- [ ] **Step 1: Add failing static/behavioral assertions**

Assert both scripts reject a dirty release and both units invoke `/usr/bin/flock --nonblock` with distinct lock paths before Python.

- [ ] **Step 2: Run Pi operations tests and confirm RED**

Run: `services/api/.venv/Scripts/python.exe -m pytest ops/pi/tests -q`.

- [ ] **Step 3: Implement fail-closed checks and locks**

Add the empty-status condition beside exact-commit validation. Wrap X and Market `ExecStart` with their unique locks while keeping the same user, environment, restart, and sandbox settings.

- [ ] **Step 4: Run operations tests and unit syntax verification**

Run operations tests locally; later `systemd-analyze verify` runs on the Debian Pi before installation.

- [ ] **Step 5: Commit**

Commit message: `fix: require immutable single-owner Pi releases`.

### Task 5: Sequential fail-closed cutover

**Files:**

- Modify: `ops/pi/cutover.ps1`
- Modify: `ops/pi/tests/test_runbooks.py`
- Modify: `docs/pi-collectors-runbook.md`

**Interfaces:**

- Produces: collector order Sentiment, X, Market, Airfare.
- Produces: `Stop-WindowsAirfare` that stops, waits with a finite deadline, disables, and rechecks the exact scheduled task.
- Consumes: successful post-baseline one-shot evidence for each collector.

- [ ] **Step 1: Add failing cutover assertions**

Assert array ordering, X stop before Pi X, Airfare Windows stop immediately before Pi Airfare, finite polling, disabled/not-running rechecks, and failure text that does not claim an unconfirmed state.

- [ ] **Step 2: Run operations tests and confirm RED**

Run: `services/api/.venv/Scripts/python.exe -m pytest ops/pi/tests -q`.

- [ ] **Step 3: Implement the ordered handoff**

Move Airfare to the final collector. Do not disable its Windows task during global preflight. At its turn, stop the exact task, poll its state until the deadline, disable it, refetch it, and require `Disabled` plus not `Running` before starting Pi Airfare.

- [ ] **Step 4: Update and test the runbook**

Document the same order, failure states, one-shot prerequisites, and unchanged rollback. Run operations tests.

- [ ] **Step 5: Commit**

Commit message: `fix: serialize Windows and Pi collector cutover`.

### Task 6: Final verification and publication gate

**Files:**

- Modify if required by verified behavior: `docs/IMPLEMENTATION_PLAN.md`
- Modify if required by verified behavior: `.superpowers/sdd/2026-09-17-pi-collectors-supabase/ledger.md`

**Interfaces:**

- Produces: one clean, verified HEAD safe to push and open as a PR.

- [ ] **Step 1: Reconcile plan, runbook, ledger, and implementation**

Check exact command names, order, heartbeat semantics, human gates, rollback, and 24-hour/seven-day language. Update only stale statements.

- [ ] **Step 2: Run the complete local matrix**

Run format, lint, web/API typechecks, API tests, web tests, production build, Pi operations tests, `npx supabase db reset`, and `npx supabase test db`.

- [ ] **Step 3: Run hygiene checks**

Run `git diff --check`, inspect `git status`, scan tracked filenames and the branch diff for credentials, and confirm no secret-bearing artifacts are staged.

- [ ] **Step 4: Request final read-only review**

Review `origin/main...HEAD`, fix every Critical/Important issue test-first, and repeat affected verification.

- [ ] **Step 5: Publish without merge**

Push `feat/pi-collectors-supabase`, set its upstream, create the PR against `main`, and inspect CI. Do not merge.
