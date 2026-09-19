# Task 11 Production Safety Repairs Design

**Date:** 2026-09-18

**Status:** Approved in chat

## Context

Tasks 1–10 established the Supabase collector data plane, Raspberry Pi
workers, systemd packaging, transfer helpers, cutover tooling, and rollback.
The pre-production review for Task 11 found that the implementation can still
accept process startup as health, overlap an already-running Windows Airfare
pass with the Pi, retain expired claimed market requests, and identify a dirty
checkout as an exact release. X and Market also lack explicit process-owner
locks and production one-shot verification of useful work.

These are release blockers. Task 11 must not publish, deploy, or change
production state until the repairs below pass the complete local verification
matrix.

## Goals

- Prove useful X and Market work after a recorded cutoff rather than merely
  proving that their processes started.
- Prevent equivalent collectors from acquiring concurrently on Windows and
  the Pi.
- Make every market request terminal no later than its declared expiry.
- Ensure the deployed commit identifies an immutable, clean checkout.
- Prevent a second local X or Market process from acquiring provider data.
- Provide disabled-unit one-shot checks for every collector before cutover.
- Preserve the additive, owner-scoped, non-destructive migration and rollback
  guarantees already defined by the Pi collectors plan and runbook.

## Non-goals

- Task 12 cleanup or removal of the Windows rollback data.
- Automatic X login or MFA.
- Secret provisioning or storage outside `/etc/edicius-hq/collectors.env`.
- Deleting Pi files, local PC data, or Supabase rows.
- Replacing `collector_runs` with a separate monitoring subsystem.

## Health Model

`collector_runs` gains a non-null `heartbeat_at timestamptz` initialized to
`started_at`. Starting a collector creates one `running` row. Completing or
failing it updates `heartbeat_at` together with the terminal state.

`CollectorCloud.heartbeat_run(run_id, records)` updates only the configured
owner's active run through the existing allowlisted REST boundary. It updates
`heartbeat_at` and cumulative non-negative `records_seen`, `records_written`,
and `records_failed` values without changing the status.

For X, a heartbeat is written only after a browser pass has completed and its
local JSONL outbox has been replayed successfully to Supabase. A successful
pass with zero new posts is still useful work and advances the heartbeat. A
capture or replica failure does not advance it.

For Market, a heartbeat is written after a reconciliation cycle has completed:
documents were loaded, pending requests were claimed to exhaustion, quote
recovery/flush ran, and the worker reached its bounded wait. Provider or cloud
failure does not advance it. The interval remains bounded by the existing
30-second reconciliation cadence.

`check-collector-run.py` continues to require a terminal `complete` row for
Airfare and Sentiment. For X and Market it requires a `running` row whose
`heartbeat_at` is on or after the supplied cutoff. The 24-hour observation uses
the same field and fails when it is older than two configured collection or
reconciliation intervals.

This design uses one run row plus an advancing heartbeat. Creating a terminal
row for every cycle would add unbounded telemetry churn, while a separate
heartbeat table would duplicate owner policies and lifecycle state.

## One-shot Verification

The production verification flow gains explicit, mutually selected live
checks while all systemd units remain disabled:

- Airfare retains the local dry run, then performs the existing controlled
  cloud-watch one-shot during its cutover gate.
- Sentiment runs one provider fetch and verifies a fresh owner-scoped snapshot
  and completed run.
- X runs exactly one authenticated browser capture, replays the retained JSONL
  outbox, verifies a post-cutoff heartbeat, and verifies the owner-scoped
  `tweet_posts` state. It exits without leaving Chromium or a watcher running.
- Market performs one bounded reconciliation and exercises quote production,
  `market-bars`, and `market-search`. It verifies terminal request results,
  expected owner IDs, non-empty valid result shapes, and elapsed time within
  the request expiry. It exits without leaving a stream or worker running.

The live X check is performed only after the human has completed login/MFA in
the imported Pi Chromium profile. Verification output contains counts, IDs,
timestamps, statuses, and sanitized error codes only; it never emits keys,
tokens, cookies, URLs containing credentials, or post payloads.

## Request Expiry

`claim_collector_request` first marks both `queued` and `running` rows with
`expires_at <= now()` as `expired`, sets `completed_at`, and then claims the
oldest remaining unexpired queued request. A late completion or failure cannot
change an expired row because terminal RPCs still require `status = 'running'`.

The worker calls the claim RPC every reconciliation interval even when the
queue is otherwise empty, so stale claimed rows become terminal within one
interval after their five-minute expiry. No request is reclaimed and provider
work is never duplicated automatically.

## Cutover Ordering and Windows Exclusion

Cutover proceeds strictly in this order:

1. Sentiment
2. X/Twitter
3. Market
4. Airfare

Before each Pi collector starts, its disabled-unit one-shot evidence must be
present and post-date the cutover baseline.

Immediately before Airfare is enabled on the Pi, the script resolves exactly
one Windows task named `Edicius airfare`, issues `Stop-ScheduledTask`, waits
with a finite timeout until its state is not `Running`, disables it, and then
rechecks both `Disabled` and not-running state. Only after these checks may the
Pi timer and service start. If the task does not stop, cutover fails and Pi
Airfare stays disabled.

The legacy X watcher is stopped and its stopped/idle state confirmed before Pi
X starts. Any ambiguous stop result blocks both copies. A failure stops the
currently attempted Pi collector and leaves later collectors disabled. The
documented rollback stops and verifies every Pi collector before it re-enables
either Windows acquisition path.

## Release Integrity and Local Ownership

Deployment, installation, and verification require:

- `HEAD` equals the pinned commit;
- the release directory is `/opt/edicius-hq/releases/<full-commit>`;
- `git status --porcelain --untracked-files=all` is empty;
- the active symlink resolves to that release; and
- the release virtual environment uses Python 3.12 or 3.13.

The X and Market systemd services execute under separate non-blocking `flock`
locks in `/var/lib/edicius-hq/locks`. A second service or manual process exits
nonzero before opening Chromium, connecting to a provider, or claiming a
request. Airfare and Sentiment retain their existing locks.

## Schema and Authorization

The heartbeat change is additive. Existing `collector_runs` rows receive
`heartbeat_at = coalesce(completed_at, started_at)` before the column becomes
non-null. RLS remains owner-scoped for authenticated browser reads, `anon`
remains denied, and service-role grants remain limited to collector tables and
RPCs. The new heartbeat operation uses the existing service-role-only data
boundary and cannot select or mutate another configured owner.

The production migration is applied only after the branch is published and a
PR exists. Local reset and pgTAP tests must prove the migration from an empty
database. Production checks must separately prove authenticated own-owner
read, cross-owner denial, anonymous denial, and the intended service-role
surface.

## Testing and Evidence

Implementation is test-first and adds regression coverage for:

- advancing X and Market heartbeats only after successful work;
- rejecting stale startup-only health rows;
- expiring both queued and running market requests;
- the Sentiment → X → Market → Airfare order;
- stopping, waiting for, disabling, and rechecking Windows Airfare;
- failing install/verify on dirty or untracked release files;
- X and Market duplicate-process lock rejection;
- one-shot X and Market success/failure contracts; and
- sanitized output and continued secret exclusion.

Before publication, the complete format, lint, typecheck, API tests, web tests,
production build, Pi operation tests, Supabase reset, pgTAP suite, diff check,
and secret-hygiene checks run again from the final HEAD.

Task 11 evidence records the exact commit, UTC timestamps, sanitized run and
request IDs, row counts, checksums, unit enabled/active states, Windows task
state, and rollback availability. The 24-hour and seven-day checkpoints remain
future observations and are never inferred from immediate success.

## Rollback

Any production failure uses `ops/pi/rollback.ps1`; no ad-hoc recovery path is
introduced. Rollback stops and disables every Pi unit, verifies all are
inactive, then restores the PC X watcher and Windows Airfare task. It does not
delete Pi state, PC data, Supabase rows, releases, profiles, archives, ledgers,
or cursors. PC data and rollback capability remain available for at least
seven days after cutover.
