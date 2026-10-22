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

## Before deployment

1. Review the branch against the active Edicius checkout. The active Pi release
   must be replaced only by a clean, pinned commit through the normal release
   process. Do not copy loose Python files into the active release.
2. Run Python tests, web typecheck/lint/tests, and `supabase test db` on a local
   database when Docker is available. Verify `supabase db push --dry-run` shows
   only `20261022000000_seace_data_plane.sql`. The remote already contains
   `20261020000000_airfare_manifest_timeout.sql`; that migration is present in
   this branch to match remote history.
3. Apply the migration with the authenticated Supabase CLI using
   `supabase db push --project-ref abndifkxpfppmllgxfnu --skip-vault`. Then run
   `supabase test db --project-ref abndifkxpfppmllgxfnu supabase/tests/seace_data_plane.sql`.
   The test file rolls back its own test records.
4. Deploy an exact clean Edicius commit to the Pi with the existing
   `deploy-pi.cmd -Commit <full-40-character-sha>` workflow. The Pi installer
   creates `/var/lib/edicius-hq/seace` and installs four disabled SEACE units.
   The existing `/etc/edicius-hq/collectors.env` already has the needed
   `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, and `EDICIUS_OWNER_ID` names. Its
   contents must never be copied, printed, or placed in Git.

## First pass and scheduled operation

Run `sudo systemctl start edicius-seace-scheduled.service` once and inspect its
exit state and `collector_runs` row. The first pass fetches all current-year
Arequipa records; later passes use source-specific overlap windows and reread
open notices. Confirm the three `seace_sync_state` rows have a recent
`fetched_at` and nonzero counts, and sample the new `/seace/recent` page.

Enable `edicius-seace-requests.timer` for owner-triggered refreshes. It polls
the request queue every two minutes. Enable `edicius-seace-scheduled.timer`
after the first pass is correct. Its initial cadence is hourly and can be
changed later. Both modes use the same nonblocking state-directory lock, so a
manual request never overlaps a scheduled pass. A queued request expires
after two hours; a later click can enqueue another.

If a pass fails after some rows upload, `seace_sync_state` may advance for an
earlier kind, but the local snapshots do not advance until all three kinds
upload. The next pass replays the overlap and upserts the same stable keys.
Exclusions live in a separate table and are never changed by a refresh.

## Rollback

Disable and stop both SEACE timers and services, then restore the previous
exact Edicius release through the normal Pi rollback. Leave SEACE tables and
Pi snapshots intact. Do not run `db reset`, truncate, or delete existing rows.
The web route can be removed or hidden independently of source data.
