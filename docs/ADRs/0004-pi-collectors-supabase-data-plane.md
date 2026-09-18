# ADR 0004 — Raspberry Pi owns provider acquisition

- **Status:** Accepted
- **Date:** 2026-09-18
- **Supersedes:** ADR 0003 sections 1 and 3 only

The Airfare archive remains append-only and authoritative, but its host moves
from the owner's PC to the Raspberry Pi. Supabase remains its indexed replica.
Authenticated browser reads use owner-gated RPCs; collectors write with a
service-role credential stored only on the Pi.

ADR 0002 and the remaining content of ADR 0003 stay accepted. In particular,
this decision retains the Airfare archive/replica distinction, the append-only
journal, and the separate replication rollback switch.

## Authority and retention

| Dataset                          | Authority                  | Supabase role                          | Pi-local role                         |
| -------------------------------- | -------------------------- | -------------------------------------- | ------------------------------------- |
| Airfare archive                  | Append-only archive on Pi  | Indexed read replica                   | Authoritative journal and sync cursor |
| Airfare watch                    | Owner document in Supabase | Authoritative watch document           | Last-known-good cache                 |
| X posts                          | Supabase                   | Durable owner archive                  | JSONL outbox until acknowledged       |
| Sentiment                        | Supabase                   | Durable normalized snapshots           | Disposable provider cache             |
| Market quotes/bars               | Upstream provider          | Latest quote and replaceable bar cache | Short-lived operational cache         |
| Investing/Airfare user documents | Supabase                   | Revisioned owner documents             | Last-known-good collector input       |

Airfare continues to obey the glossary distinction between **Airfare archive** and **Airfare replica**. This design changes the archive host from PC to Pi; it does not make Supabase the Airfare write authority.

## Decision

The Pi is the only provider-facing runtime and exposes no public HTTP API.
Browser identities remain bounded by Supabase Auth. `edicius_owners` is the
allow-list for owner-scoped application data; it is initially backfilled from
`finance_documents`. Service-role credentials are confined to the Pi and
explicit operator tooling. The X browser profile stays a private Pi asset.

Existing Airfare tables and their original RPCs remain service-role-only.
Security-definer wrappers verify an authenticated Edicius owner before calling
the Airfare readers. Browser market bar and search work enters a short-lived,
owner-scoped request/result queue that a Pi worker claims atomically.

## Rollback rules

Rollback disables Pi units and re-enables the Windows task/API watcher. It never truncates Supabase or deletes Pi journals.

Keep PC source files unchanged for at least seven days. A rollback re-enables
the retained local authority and must not be implemented by `db reset --linked`,
deletion, truncation, or an unapproved down migration.
