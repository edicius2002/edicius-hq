# ADR 0003 — Airfare Supabase indexed read replica

- **Status:** Accepted
- **Date:** 2026-09-15
- **Context:** Delivery step 6b — Airfare archive replication
- **Supersedes:** nothing

## Context

The local Airfare archive is the only record of many historical fares, while its
largest active snapshot journal (`AQP-LIM.jsonl`, 24.32 MiB) makes a whole-pair scan an
increasingly expensive read. The measured inventory on 2026-09-15 was about 51.2 MiB
of logical source data: 13,722 snapshots (41.15 MiB), 59,785 baseline points (6.98
MiB), 164 calendar captures (1.13 MiB), more than 16,800 checks (1.95 MiB), and a
seven-route watch. These are a dated measurement, not a quota.

The alternatives are to keep every read as a filesystem scan, move the collector and
authority to cloud storage, or keep collection local while introducing an indexed read
copy. The first leaves the growing read cost unchanged; the second breaks the
residential-egress constraint and risks the only durable history. This decision takes
the third option through migration `20260915000000_airfare_archive.sql`.

## Decision

### 1. Local collection and journal remain authoritative

Google Flights collection stays on the owner's PC and the append-only local JSONL/JSON
archive remains the write authority and recovery journal. `AirfareData` is the only
storage-selection seam for Airfare history, calendar, airport, and synchronization
answers; routes and collection jobs do not own cloud storage knowledge.

The Airfare watch is replicated only for recovery and a future shared-KV migration.
Its local atomic KV document remains write-authoritative. This ADR authorizes neither
local archive deletion or pruning nor backup upload, ledger/state/catalog removal, or
any Storage migration.

### 2. Postgres is an indexed replica and read store

Supabase Postgres receives content-addressed observations. Each append-only record's
identity hashes its kind, normalized city pair, and canonical original row, so a replay
is safe and different observations sharing a timestamp remain distinct. Natural-key
upserts are retained where provider baseline revisions replace a point.

The replica stores the original wire documents alongside indexed route/date columns.
It supplies bounded route/month reads and the whole-pair reference without making the
browser aware of tables, RPCs, hashes, or fallback. Repeated `snapshotMonth=YYYY-MM`
limits snapshots to watched months; omitted months retain the legacy whole-pair read.
`pairReference` remains a whole-pair calculation rather than a watched-month statistic.

### 3. The PC backend is the only Supabase client

The passkey-gated PC API remains the browser's only data endpoint. Its server-only
`SUPABASE_SECRET_KEY` is sent to the Data API in the `apikey` header; it is never a
browser value, `VITE_*` value, URL parameter, report value, or `Authorization` header.
All archive tables use RLS, `public`/`anon`/`authenticated` access is revoked, and only
the backend's `service_role` has the specific read/upsert and RPC grants needed here.

### 4. Reads have a one-flag rollback; replication is separate

Set `AIRFARE_DATA_BACKEND=local` and restart the API to return reads to the retained
local journal. Set `AIRFARE_SYNC_ENABLED=false` separately when replication must stop.
Neither change deletes remote rows or local files. A failed cloud read falls back to
the local archive and is logged as a source change; it is never represented as a
successful empty history. `db reset --linked`, deletion, truncation, and an unapproved
down migration are not rollback procedures.

The detailed importer and report contract is
[the Airfare synchronization contract](../airfare-sync-contract.md). The controlled
operator sequence and evidence gates are in [the deployment plan](../deploy-plan.md#airfare-replica-operator-runbook).

## Consequences

**Enabled**

- Indexed read paths avoid transferring discarded departure months to the page.
- Content identity, manifests, and read comparison make a frozen-source reconciliation
  checkable without exposing source rows.
- The local journal stays available for collection continuity and read fallback.

**Accepted costs**

- Two copies must be reconciled and observed rather than treated as interchangeable.
- Supabase reads add a remote dependency, so the retained local fallback and its
  restart procedure remain operational requirements.
- A later change of authority would require a new ADR and a migration plan; replication
  itself is not that change.

## Alternatives considered

**Keep whole-pair filesystem reads.** Avoids a replica and external dependency.
Rejected because the measured canary already dominates the active archive and watched
months can be read precisely from an index.

**Move collection and authority to Supabase.** Centralizes writes and reads. Rejected:
Google Flights collection is constrained to residential egress, and the local archive
is the only historical journal.

**Let the browser read Supabase directly.** Removes a PC API hop. Rejected because the
browser has no cloud-verifiable identity in this phase and must not receive a secret
key; the existing passkey gate remains at the PC API.
