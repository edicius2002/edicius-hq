# Raspberry Pi Collectors and Supabase Data Plane Design

**Status:** Approved for implementation planning
**Date:** 2026-09-17
**Scope:** Airfare, X posts, market/Investing data, sentiment, their required owner documents, and Raspberry Pi operations.

## Objective

When the Raspberry Pi 5 boots and obtains Internet access, every automated provider acquisition process starts or resumes without the Windows PC. The PC runs no scheduled collector, browser automation, market stream, sentiment fetch, or provider-facing fallback after cutover. The authenticated web application reads owner documents and collected data from Supabase.

## Boundaries

- The Pi runs collectors only. It does not serve a public HTTP API.
- All Pi traffic is outbound HTTPS or WebSocket traffic.
- Supabase Auth remains the browser identity boundary. The service-role secret is present only on the Pi and in explicit operator tooling.
- The X browser profile remains a private local Pi asset and is never uploaded to Supabase.
- Finance diagram documents keep their existing `finance_documents` contract.
- Interactive market bars and symbol searches travel through an owner-scoped Supabase request/result channel; they do not call the PC API.
- NATS/JetStream and a PC consumer are not part of the target design.

## Data authority and retention

| Dataset                          | Authority                  | Supabase role                          | Pi-local role                         |
| -------------------------------- | -------------------------- | -------------------------------------- | ------------------------------------- |
| Airfare archive                  | Append-only archive on Pi  | Indexed read replica                   | Authoritative journal and sync cursor |
| Airfare watch                    | Owner document in Supabase | Authoritative watch document           | Last-known-good cache                 |
| X posts                          | Supabase                   | Durable owner archive                  | JSONL outbox until acknowledged       |
| Sentiment                        | Supabase                   | Durable normalized snapshots           | Disposable provider cache             |
| Market quotes/bars               | Upstream provider          | Latest quote and replaceable bar cache | Short-lived operational cache         |
| Investing/Airfare user documents | Supabase                   | Revisioned owner documents             | Last-known-good collector input       |

Airfare continues to obey the glossary distinction between **Airfare archive** and **Airfare replica**. This design changes the archive host from PC to Pi; it does not make Supabase the Airfare write authority.

## Collector behavior

### Airfare

- A `systemd` timer invokes one collection pass every 15 minutes.
- Each pass refreshes `airfare-routes` from Supabase, atomically updates the Pi cache, collects against the residential connection, appends locally, and performs the existing incremental replica sync.
- Loss of Supabase does not discard collected observations. A later successful pass retries the retained journal.

### X posts

- One long-running service owns the persistent Chromium profile and the `thsottiaux` watcher.
- It captures profile and replies tabs on the existing bounded cadence.
- It appends locally before attempting a deterministic Supabase upsert. A cursor advances only after the remote upsert succeeds.
- A fatal session failure stops retries, records a sanitized failed run, and requires the operator to refresh the X session.

### Sentiment

- A timer runs every four hours and once after boot/network recovery.
- It reuses the current CNN/mirror normalization and writes one idempotent snapshot keyed by owner, source, and `as_of`.
- Provider failure preserves the last successful Supabase snapshot and records run health; it never overwrites good data with an empty payload.

### Investing market data

- A long-running worker reads the union of `watchlist`, `portfolio`, and active alert symbols from owner documents.
- Provider ticks are coalesced into one owner-private Realtime Broadcast batch at most every 500 ms. `market_quotes` is a complete recovery snapshot updated no more than once per symbol every 60 seconds and is not in the Postgres Changes publication.
- Bars and symbol-search requests are inserted by the authenticated browser into `collector_requests`. The Pi receives them through Supabase Realtime, with a 30-second polling reconciliation path after reconnects.
- A request is atomically claimed by one worker, completed once, and expires after five minutes.
- Bar cache rows replace the whole normalized series for `(owner, symbol, timeframe, extended)`. Raw ticks are not retained.

## Supabase authorization

- `edicius_owners` contains the allowed application owner IDs and is initially backfilled from `finance_documents`.
- New owner tables carry `owner_id` and enforce `owner_id = auth.uid()` for authenticated reads/writes that originate in the browser.
- Provider data writes are granted only to `service_role`.
- Existing Airfare tables remain hidden. New security-definer read RPCs first verify the caller in `edicius_owners`, then call the existing service-only Airfare RPCs.
- The Postgres Changes publication includes only `tweet_posts`, `collector_runs`, and `collector_requests`; owner-private market ticks use Realtime Broadcast, and no secret or browser profile material is published.

## Browser behavior

- `shared/storage` changes from the PC KV API to revisioned Supabase owner documents.
- Dashboard tweets, sentiment, Investing quotes/bars/search, Airfare archive reads, and collector health use the authenticated Supabase client.
- The Dashboard no longer starts or stops X. It displays collector health and new rows delivered through Realtime.
- Airfare manual collection controls become status-only in this delivery. Automatic collection is the authority; a general manual-command UI is not introduced.
- Existing PC API provider routes remain during a rollback window but are removed from browser call paths before cutover.

## Raspberry Pi runtime

- Debian 13 ARM64, Python 3.12, Playwright 1.62.0, Chromium, and a dedicated `edicius` system user.
- Repository releases live under `/opt/edicius-hq/releases/<commit>` with `/opt/edicius-hq/current` as the active symlink.
- Durable state lives under `/var/lib/edicius-hq`; secrets live in `/etc/edicius-hq/collectors.env` with mode `0600`.
- Services use `After=network-online.target`, bounded restart backoff, local single-owner locks, and journald.
- No automatic `git pull` occurs at boot. Deployment activates an explicitly tested commit.

## Cutover and rollback

1. Apply and verify schema and RLS before deploying workers.
2. Import owner documents and existing X JSONL without deleting PC data.
3. Install Pi services disabled; run one-shot and dry-run verification.
4. Stop the Windows Airfare task and PC X watcher before enabling equivalent Pi units.
5. Enable one collector at a time and verify Supabase rows plus collector health.
6. Keep PC source files unchanged for at least seven days.
7. Rollback disables Pi units and re-enables the Windows task/API watcher. It never truncates Supabase or deletes Pi journals.

## Architectural conflict

This design changes ADR 0003 sections 1 and 3: collection moves from the PC to the Pi and the authenticated browser gains narrow, owner-gated Supabase reads. Implementation must add a new ADR that explicitly supersedes those sections while retaining the append-only Airfare archive and replica semantics from ADRs 0002 and 0003.

## Acceptance criteria

- Rebooting the Pi with Internet available starts all four acquisition paths without user login.
- Turning the PC off does not stop Airfare, X, sentiment, quotes, bars, or queued search processing.
- No browser bundle or log contains `SUPABASE_SECRET_KEY` or X cookies.
- Duplicate runs and retries produce no duplicate durable rows.
- A Supabase outage leaves Airfare/X data recoverable locally and automatically replayable.
- The production web app receives market and tweet changes through Supabase Realtime.
- Windows contains no enabled Edicius scheduled collector after the observation window.
