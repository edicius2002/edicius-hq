# ADR 0005 — Retain exact Airfare history after departure detail expires

## Status

Accepted for implementation; production rollout is gated by replica identity and staging equivalence.

## Context

The Raspberry Pi is the durable Airfare source. Its JSONL journals and the indexed
read replica previously retained every flight observation indefinitely. That
duplicates large offer payloads for flights that have already departed. A flight
that departs in the future still needs its entire observation history, however
old the observation is.

## Decision

The exclusive UTC cutoff is `today - 1 day`: a departure on day D becomes
eligible on D+2. For each eligible route and departure date, the Pi stores one
immutable numeric partition with price frequencies by observation day, provider
frequencies, unsold counts, health, last capture and the departure minimum.
These frequencies preserve an exact daily median when a month mixes departed
and future flights. The Pi and replica then remove offer-level snapshots,
baseline rows and board checks below the cutoff. Calendar curves lose expired
departure points; their route-level health checks remain. Owner watch documents
are unchanged.

A durable pending state and the shared maintenance lock block local writers
during a run. The replica's database trigger blocks new expired rows. A run
publishes partitions and checks their keys and digests before replacing local
journals or pruning the replica. It finishes only after complete route manifests,
source identities and cutoff agree. The daily timer is installed disabled until
the first supervised run verifies. A failed run resumes with its original ID and
cutoff.

The active application code uses Supabase PostgREST and Supabase Auth. The
request names Neon; a separate Neon database has not been established as the
application replica. Production rollout must identify the actual target and
adapt the transport/migrations if that target is a distinct Neon project.

## Consequences

The Airfare archive remains authoritative but is no longer indefinitely
append-only. Its durable historical form is active detail plus immutable
departure summaries. `How the price moved` keeps numeric history; `Flights seen`
shows only remaining flights. A fallback history read merges the same summaries.
Old application versions that can write below the cutoff are incompatible with
the new contract. Extra copies outside the active `fares/` tree must be reviewed
before claiming expired detail was removed from the Pi.

See [the rollout runbook](../airfare-retention.md) and the earlier
[archive](./0002-airfare-price-history-store.md),
[read replica](./0003-airfare-supabase-read-store.md) and
[Pi data plane](./0004-pi-collectors-supabase-data-plane.md) decisions.
