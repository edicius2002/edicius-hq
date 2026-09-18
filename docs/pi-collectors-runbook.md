# Pi collector deployment, cutover, and rollback

This runbook moves collectors to a Debian 13 ARM64 Pi without making a
branch tip or the Windows PC an authority. Substitute only angle-bracketed
placeholders; commands never accept secrets, cookies, or owner IDs as CLI
arguments. Record the exact pinned commit in the change ticket before start.

## Roles and two required manual steps

Every command below is agent/operator executable except these two actions.

1. **HUMAN-ONLY — securely install `/etc/edicius-hq/collectors.env`.** Create
   it directly on the Pi through an approved secret channel, containing only
   the required values documented by `ops/pi/install.sh`; set owner `root:root`
   and mode `0600`. Do not paste, print, screenshot, or pass its values on a
   command line.
2. **HUMAN-ONLY — satisfy X login/MFA.** At the approved local Pi console,
   complete the interactive X login/MFA into the imported Chromium profile.
   Do not export cookies, tokens, or screenshots.

## Preconditions and checkpoint A: data plane

Keep the PC source files, task, and API watcher unchanged. Confirm an exact
release commit, not a branch name or `latest`:

```sh
export COMMIT='<40-hex-pinned-commit>'
test "$COMMIT" = "$(git rev-parse "$COMMIT")"
git status --porcelain
```

Apply the reviewed schema from the pinned checkout with the project’s
approved Supabase migration command, then run the SQL data-plane tests. Owner bootstrap
on a fresh project adds the application owner in `edicius_owners` before any
import; use the approved migration/administration session, with
`'<owner-uuid>'` only as a placeholder. Verify the owner is unique and that
RLS grants browser reads only to that owner and service-role writes only to
collectors. Do not put the service role in a browser or command history.

Run the additive app-document import from PC documents without overwriting remote documents:

```sh
cd /opt/edicius-hq/releases/$COMMIT
services/api/.venv/bin/python scripts/app-documents-supabase.py \
  --source '<pc-kv-directory>' --owner-id '<owner-uuid>' --apply
```

Use the pinned migration/import tooling for existing X JSONL/history; it must
be additive and idempotent. Compare the source and Supabase counts by owner,
handle, and timestamp range. Transfer the Airfare durable archive and sync
state as a copied, checksummed archive into `/var/lib/edicius-hq`; preserve
its journal and cursor together, then set `edicius:edicius`, mode `0750` for
directories and restrictive file modes. Never replace or truncate either the
PC archive, Pi journal, or Supabase rows.

Checkpoint A passes only when schema/RLS tests pass, the owner has been
bootstrapped, imports have recorded row counts, and the Airfare archive/state
is readable by `edicius` but not by other users.

## Deploy an exact release and checkpoint B: disabled install

On the Pi, install Chromium and the pinned checkout under its commit path.
The deployment process may clone/fetch while preparing the release, but it
must activate only the recorded commit and must never use `git pull` at boot
or activate a moving branch:

```sh
sudo apt-get update
sudo apt-get install --yes chromium
sudo install -d -o root -g root -m 0755 /opt/edicius-hq/releases
sudo git clone '<repository-url>' /opt/edicius-hq/releases/$COMMIT
sudo git -C /opt/edicius-hq/releases/$COMMIT checkout --detach "$COMMIT"
test "$COMMIT" = "$(sudo git -C /opt/edicius-hq/releases/$COMMIT rev-parse HEAD)"
sudo ln -sfn /opt/edicius-hq/releases/$COMMIT /opt/edicius-hq/current
sudo /opt/edicius-hq/current/ops/pi/install.sh
```

Install the profile only after it has been copied to a controlled Pi-local
staging directory with no symlinks. The importer refuses a live profile unless
an explicit backup-and-replace flag is supplied, preserves a dated backup, and
does not log profile contents:

```sh
sudo /opt/edicius-hq/current/ops/pi/import-x-profile.sh --dry-run '<profile-staging-directory>'
sudo /opt/edicius-hq/current/ops/pi/import-x-profile.sh '<profile-staging-directory>'
```

Run the two manual actions above at their controlled points. Then assert that
units are installed but disabled, and run safe verification plus one-shot
checks without cutover:

```sh
sudo systemctl is-enabled edicius-airfare.timer edicius-sentiment.timer edicius-tweets.service edicius-market.service
sudo /opt/edicius-hq/current/ops/pi/verify.sh
sudo /opt/edicius-hq/current/ops/pi/verify.sh --live
sudo systemctl start edicius-airfare.service
sudo systemctl start edicius-sentiment.service
sudo journalctl -u edicius-airfare.service -u edicius-sentiment.service --since '-15 minutes' --no-pager
```

Stop the one-shot services if still active; do not enable any unit yet.
Checkpoint B requires each `is-enabled` result to be `disabled`, `verify.sh`
to succeed, and one-shot logs to show no secret/profile content.

## Baseline, cutover, and observation

Before cutover, capture operator-visible Supabase counts and health for the
same owner and time window: `collector_runs` by collector/status,
`tweet_posts`, `sentiment_snapshots`, `market_quotes`, and the Airfare replica
health/check total. Save the query result outside the repository, with no
credentials. This is the baseline for row/health comparison.

From the Windows operator host, invoke the guarded script. It validates the
exact scheduled task, proves Pi verification succeeds and all Pi units are
installed/disabled, then disables only `Edicius airfare`. It enables one Pi
collector at a time and stops on a unit/health failure:

```powershell
Set-Location '<pinned-checkout>\ops\pi'
.\cutover.ps1 -PiHost '<pi-dns-name>' -WhatIf
.\cutover.ps1 -PiHost '<pi-dns-name>'
```

After each unit is enabled, compare new Supabase rows and latest successful
collector health to the baseline; check Pi journald for a sanitized successful
run. The required order is Airfare, sentiment, X, then market. Do not disable
any additional PC component until its equivalent Pi collector has passed its
comparison. Observe continuous service/timer status, collector health, rows,
and journal errors for seven days. Retain the unchanged PC data and rollback
path throughout that seven-day PC retention window.

## Rollback

Rollback is appropriate for failed health/row comparisons, a failed X session,
or any unexpected Pi collector behavior. It does not delete, truncate, or
replay data manually. From the Windows operator host:

```powershell
Set-Location '<pinned-checkout>\ops\pi'
.\rollback.ps1 -PiHost '<pi-dns-name>' -WhatIf
.\rollback.ps1 -PiHost '<pi-dns-name>'
```

The script stops and disables all Pi units before it enables the exact Windows
task. If a Pi stop cannot be confirmed, it reports partial rollback and leaves
the Windows task disabled to avoid double collection. Inspect remaining unit
state and journal records, reconcile only through the normal idempotent sync,
and retain all Pi/PC/Supabase data for incident review.
