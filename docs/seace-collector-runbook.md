# SEACE in edicius-hq

SEACE uses the existing Supabase project, owner allowlist, service-role secret on
`bodas`, and the collector request queue. The tables `seace_records`,
`seace_sync_state`, and `seace_exclusions` are independent of Finance, Airfare,
and market data. The website is available at `/seace/recent`, `/seace/all-open`,
`/seace/closed`, and `/seace/published` after the web release is built.

The SEACE MCP source in `services/seace/vendor/seace_mcp/server.py` is a copy
of the locally modified `pipaacebedo/seace-mcp` project, version 0.2.2, under
its bundled Apache-2.0 license. It contains the minor-contract notice filter
that was tested on `bodas`. Keep that modification when updating the vendor.

## Import the existing local exclusions

The older prototype keeps its decisions in `D:\Work\war_dogs\.seace-exclusions.json`.
That file is not included in the public Edicius repository or web bundle. After
the web release, sign in to `/seace/recent`, choose that JSON in **Exclusion JSON
file**, and review the number of codes shown by the **Import**
button before applying it. The authenticated browser adds those keys to
`seace_exclusions`; existing saved exclusions remain. The sidebar then shows
the total number of excluded codes. Use **Not excluded** and **Excluded** on
each SEACE page to inspect the split. Later exclude and restore actions are
saved in Supabase. Importing the same file again re-adds any keys restored
since the previous import, so use it as a one-time migration.

## Before deployment

1. Review the branch against the active Edicius checkout. The active Pi release
   must be replaced only by a clean, pinned commit through the normal release
   process. Do not copy loose Python files into the active release.
2. Run Python tests, web typecheck/lint/tests, and `supabase test db` on a local
   database when Docker is available. Verify `supabase db push --dry-run` shows
   only `20261022000000_seace_data_plane.sql`. The remote already contains
   `20261020000000_airfare_manifest_timeout.sql`; that migration is present in
   this branch to match remote history.
3. The migration was applied to project `abndifkxpfppmllgxfnu` on 2026-10-22.
   Verify it appears in the migration list, then run the remote test:

   ```powershell
   supabase migration list --project-ref abndifkxpfppmllgxfnu
   supabase test db --linked --project-ref abndifkxpfppmllgxfnu supabase/tests/seace_data_plane.sql
   ```

   The remote test passed with 26 assertions. It rolls back its own records and
   temporary schema grant.

4. Deploy an exact clean Edicius commit to the Pi with the existing
   `deploy-pi.cmd -Commit <full-40-character-sha>` workflow. The Pi installer
   creates `/var/lib/edicius-hq/seace` and installs four disabled SEACE units.
   The existing `/etc/edicius-hq/collectors.env` already has the needed
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `EDICIUS_OWNER_ID` names. Its
   contents must never be copied, printed, or placed in Git.

## First pass and scheduled operation

Run `sudo systemctl start edicius-seace-notices.service` and
`sudo systemctl start edicius-seace-scheduled.service` once and inspect their
exit states and `collector_runs` rows. Together they fetch current-year
Arequipa records; later passes use source-specific overlap windows and reread
open notices. Confirm all three `seace_sync_state` rows have a recent
`fetched_at` and nonzero counts, and sample the new `/seace/recent` page.

Enable `edicius-seace-requests.timer` for owner-triggered refreshes. It polls
the request queue every two minutes. Enable `edicius-seace-scheduled.timer`
after the first pass is correct. It refreshes general processes and published
contracts hourly. `edicius-seace-notices.timer` refreshes minor notices every
five minutes and is enabled by the pinned release deployment. All three modes
use the same nonblocking state-directory lock, so a
manual request never overlaps a scheduled pass. A queued request expires
after two hours; a later click can enqueue another.

The notice pass searches for new and changed minor notices, rereads active
statuses and enriches at most 20 IDs per pass. Changed, still-open source rows
reenroll completed detail and file phases while preserving the last successful
items and documents until replacement data arrives. Manual refreshes still
include all three sources. Each source publishes and advances its own snapshot
only when selected by that pass.

The prod6 MCP keeps one second between HTTP starts and a maximum of five
in-flight requests. On the first HTTP 403 it writes an epoch deadline to
`$SEACE_STATE_DIR/prod6-cooldown-until` and rejects queued prod6 requests
without another HTTP attempt. The default cooldown is 900 seconds, adjustable
with `SEACE_PROD6_403_COOLDOWN_SECONDS`. The five-minute notice service skips
scheduled passes while that deadline is active; the hourly core service remains
independent. After expiry the next scheduled notice pass resumes automatically.
Inspect `journalctl -u edicius-seace-notices.service` and the cooldown deadline
if a notice snapshot stops advancing. The cooldown file is Pi-local state and
must be retained across releases.

If a pass fails after some rows upload, `seace_sync_state` may advance for an
earlier selected kind, but the local snapshots do not advance until all selected
kinds upload. The next pass replays the overlap and upserts the same stable keys.
Exclusions live in a separate table and are never changed by a refresh.

## Paged explorer rollout

Apply `20261024000000_seace_paged_read.sql` before publishing the web bundle
that calls `read_owner_seace_page`. The migration backfills the derived read
fields and installs a trigger, so the existing collector's payload-only upserts
continue to update them. Run `supabase/tests/seace_paged_read.sql` against a
local Supabase database before applying the migration to the hosted project.

After publishing, sign in and time a full reload of each of `/seace/recent`,
`/seace/all-open`, `/seace/closed`, and `/seace/published` from navigation until
the loading message disappears. Record the result count and the RPC's network
duration and response size. Confirm that each call returns no more than the
selected page size (50 by default), and compare with the pre-change Arequipa
measurements of 7.5 s, 7.4 s, 9.4 s, and 7.4 s respectively. An isolated
PostgreSQL run with 7,031 rows measured 16 ms for recent and 31 ms for closed;
these are database-only timings and are not a prediction of browser latency.

## Persistent minor-notice enrichment queue

Minor-notice discovery commits every returned ID to
`$SEACE_STATE_DIR/notice-pending.sqlite3` before requesting details or advancing
the search checkpoint. The key is `(region, year, notice ID)`; repeated search
rows update the same entry. Both systemd services already set `SEACE_STATE_DIR`
to `/var/lib/edicius-hq/seace`, outside the versioned release, and allow writes
there with `ReadWritePaths`. The installer creates the directory for
`edicius-collector`. These are repository configuration checks; verify the
installed units and directory permissions before a later deployment.

The queue retains the discovered source row, saved enrichment responses,
discovery time, per-phase attempt counters, last errors and `next_attempt_at`.
Detail and files
each have independent `deferred`, `pending`, `ready`, and `complete` states. All
IDs are recorded, but only notices initially `Vigente` with a future deadline
automatically enter `pending`; closed historical IDs remain `deferred`. `ready` means
a valid response is saved locally and awaits publication. Only a successful
publisher followed by successful writes of all snapshots acknowledges those
phases as `complete`. A crash or partial upload replays saved responses through
the same stable record keys; it does not refetch a `ready` phase. The snapshot
and published record carry an additive `enrichment` field with `detail` and
`files` availability; existing UI fields and exclusions keep their contracts.
An empty list from a successful files request is valid; a failed files request
is never interpreted as an empty list. The publisher sends merged rows so
previous items and documents survive partial failures in Supabase as well as
in the local snapshot.

First attempts retain the previous open-notice eligibility. Retries are limited
to 20 previously attempted IDs per collection pass, choosing the least recently
attempted first across all phases. Each selected phase gets at most one tool
attempt, in sequential batches of at most 20 IDs. The MCP retains its existing HTTP retry
policy and default concurrency; there is no immediate collector retry loop
for 403 responses. A numeric positive `retry_after_seconds` from the MCP sets a
durable minimum next-attempt time for that phase, including after a restart;
waiting phases do not consume the retry budget or block a different due phase.
There is no collector sleep for a long `Retry-After`. A failed or missing phase remains pending after the notice
closes. An archive-only retry uses `fase=files`, and a detail-only retry uses
`fase=detail`; install the companion MCP transport change with that interface
before deploying this queue. The older all-phases response format remains
readable, but does not preserve detail when its archive request fails.

Keep the database and snapshots across releases and rollback. If the database
is absent, the collector seeds pending work from the selected region/year's
notice snapshot, preserving its items and documents. Snapshot enrichment
metadata restores enrollment even after closure; eligible open legacy rows are
also enrolled, while closed legacy rows without enrollment evidence remain
deferred. Enrolled rows conservatively recheck both phases. A corrupt database stops the pass; it is not silently
replaced. IDs discovered since the last snapshot exist only in SQLite, so
losing both the queue and those uncommitted discoveries requires another full
source search (`refresh_region(..., full=True)`). Source data that has also
disappeared cannot be reconstructed locally. No Supabase schema migration is
needed for this Pi-local queue.

Pending entries do not expire or get deleted automatically. Retries are scoped
to the region/year being collected: older years require an explicit pass for
that year after the calendar rolls over. Historical backfill requires explicit
activation of a selected small set of IDs through
`PendingNotices().activate(region, year, identifiers)` under the same pass lock;
it does not run automatically at first startup. No throughput or completion-time
guarantee has been measured on `bodas`. There are no queue
leases: the existing shared `seace.lock` is the single-writer boundary, so do
not invoke the standalone prototype refresher concurrently with the collector.
Standalone refresh without a publisher leaves fetched phases `ready`.

## Rollback

Disable and stop the three SEACE timers and services, then restore the previous
exact Edicius release through the normal Pi rollback. Leave SEACE tables and
Pi snapshots intact. Do not run `db reset`, truncate, or delete existing rows.
The web route can be removed or hidden independently of source data.
