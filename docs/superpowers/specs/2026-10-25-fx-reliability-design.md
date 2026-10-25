# FX collector reliability

## Intent

Keep five-minute commercial captures continuous across host daylight-saving changes, distinguish malformed provider responses, and expose each source's acquisition health. The October 24–25 incident showed one shared BCRP response failing for BCRP/SBS, isolated Kambista failures, and a 65-minute FX timer gap when Europe/London left summer time.

## Constraints

- Preserve the pinned Pi release workflow and the existing append-only FX observations and local outbox.
- Do not retain upstream response bodies, cookies, credentials, or request payloads in diagnostics.
- Do not mistake a skipped source for a successful acquisition or confuse a daily reference's effective date with its fetch time.
- Keep source health local so acquisition continues during a Supabase outage. Existing `collector_runs` remains the aggregate cloud signal.

## Approaches

- **Chosen:** Make the timer explicitly UTC; classify provider failures in memory; persist source attempt, success, failure and next due in the existing FX SQLite database; report stale sources in the aggregate pass result. This is reversible and needs no hosted schema change.
- Use only systemd failure logs. This does not reveal skipped stale sources and loses health across passes.
- Add a Supabase source-health table. This adds a hosted migration and makes local acquisition health depend on cloud availability.

## Behavior

- `OnCalendar` uses UTC. A calendar check across 2026-10-25 00:55 UTC must show 01:00 UTC as the next slot.
- Provider failures retain a safe code and metadata: stage, HTTP status, response size and exception class. A known HTML challenge is named as such; no body is stored or logged.
- Every attempted source updates local health atomically with its due time and outbox write. Success resets consecutive failures. Failure retains the last success and its reason. Existing SQLite databases upgrade in place.
- A skipped commercial source older than 15 minutes, or skipped BCRP/SBS source older than five hours, makes the pass unhealthy and logs the source. These thresholds describe acquisition freshness; they do not judge the economic date of daily data.
- The first malformed Kambista response gets one retry on the next five-minute timer slot. Later consecutive failures use the provider's normal delay. Explicit 403/429 delays stay authoritative.
- A status command prints bounded, non-secret per-source health for operator inspection.

## Limits

The October failed response bodies were not captured, so this work improves the next diagnosis; it does not retroactively prove whether those bodies contained a challenge. A local warning is not an external paging service. Production deployment still follows the pinned release procedure.
