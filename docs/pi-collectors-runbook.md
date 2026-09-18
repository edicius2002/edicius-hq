# Pi collector deployment, cutover, and rollback

This runbook moves collectors to a Debian 13 ARM64 Pi without making a
branch tip or the Windows PC an authority. Substitute only angle-bracketed
placeholders; commands never accept secrets or cookies as CLI arguments.
Record the exact pinned commit in the change ticket before start.

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

Use a credential-injecting operator environment for `SUPABASE_ACCESS_TOKEN`
and `SUPABASE_DB_URL`; neither value is an argument, transcript value, or
repository file. From the exact pinned checkout, apply and verify schema/RLS,
then bootstrap the owner on a fresh project:

```sh
cd '<pinned-checkout>'
npx supabase link --project-ref '<supabase-project-ref>'
npx supabase db push --linked
npx supabase migration list --linked
psql "$SUPABASE_DB_URL" -X -v ON_ERROR_STOP=1 -v owner_id='<owner-uuid>' \
  -c "insert into public.edicius_owners(owner_id) values (:'owner_id'::uuid) on conflict do nothing;" \
  -c "select owner_id from public.edicius_owners where owner_id = :'owner_id'::uuid;"
npx supabase test db supabase/tests/collector_data_plane.sql
```

The migration list must show the pinned checkout and linked project at the
same version. The `psql` query is idempotent and its one-row result is the
owner bootstrap checkpoint; RLS tests must pass before collector deployment.

Copy the PC input to the Pi without a secret on an argument, then perform an
app-document import dry-run, apply, and repeated-apply idempotency checks through a
transient Pi process that reads the protected env file locally:

```sh
ssh '<pi-host>' 'sudo install -d -o edicius -g edicius -m 0750 /var/lib/edicius-hq/migration-input/kv'
rsync -a --checksum --protect-args '<pc-kv-directory>/' '<pi-host>:/var/lib/edicius-hq/migration-input/kv/'
ssh '<pi-host>' "sudo systemd-run --quiet --wait --collect --uid=edicius --property=EnvironmentFile=/etc/edicius-hq/collectors.env --property=WorkingDirectory=/opt/edicius-hq/current /opt/edicius-hq/current/services/api/.venv/bin/python scripts/app-documents-supabase.py --source /var/lib/edicius-hq/migration-input/kv --owner-id '<owner-uuid>'"
ssh '<pi-host>' "sudo systemd-run --quiet --wait --collect --uid=edicius --property=EnvironmentFile=/etc/edicius-hq/collectors.env --property=WorkingDirectory=/opt/edicius-hq/current /opt/edicius-hq/current/services/api/.venv/bin/python scripts/app-documents-supabase.py --source /var/lib/edicius-hq/migration-input/kv --owner-id '<owner-uuid>' --apply"
ssh '<pi-host>' "sudo systemd-run --quiet --wait --collect --uid=edicius --property=EnvironmentFile=/etc/edicius-hq/collectors.env --property=WorkingDirectory=/opt/edicius-hq/current /opt/edicius-hq/current/services/api/.venv/bin/python scripts/app-documents-supabase.py --source /var/lib/edicius-hq/migration-input/kv --owner-id '<owner-uuid>' --apply"
```

For X JSONL/history, copy the existing outbox before X is enabled. The worker's
first start replays this durable outbox before opening Chromium; preserve its
cursor alongside the JSONL and prove transfer equality without printing rows:

```sh
(cd '<pc-local-data>/tweets' && find . -type f -print0 | sort -z | xargs -0 sha256sum) > '<pc-x-manifest>'
ssh '<pi-host>' 'sudo test ! -e /var/lib/edicius-hq/tweets && sudo install -d -o edicius -g edicius -m 0750 /var/lib/edicius-hq/migration-input/tweets'
rsync -a --checksum --protect-args '<pc-local-data>/tweets/' '<pi-host>:/var/lib/edicius-hq/migration-input/tweets/'
ssh '<pi-host>' 'cd /var/lib/edicius-hq/migration-input/tweets && find . -type f -print0 | sort -z | xargs -0 sha256sum' > '<pi-x-manifest>'
wc -l '<pc-x-manifest>' '<pi-x-manifest>'
diff -u '<pc-x-manifest>' '<pi-x-manifest>'
ssh '<pi-host>' 'sudo chown -R edicius:edicius /var/lib/edicius-hq/migration-input/tweets && sudo mv /var/lib/edicius-hq/migration-input/tweets /var/lib/edicius-hq/tweets'
```

Transfer the Airfare archive, sync cursor, and journals together. These
commands refuse an existing Pi archive and never delete or overwrite the PC
source; keep the source manifest with the change record:

```sh
(cd '<pc-local-data>/fares' && find . -type f -print0 | sort -z | xargs -0 sha256sum) > '<pc-airfare-manifest>'
ssh '<pi-host>' 'sudo test ! -e /var/lib/edicius-hq/fares && sudo install -d -o edicius -g edicius -m 0750 /var/lib/edicius-hq/migration-input/fares'
rsync -a --checksum --protect-args '<pc-local-data>/fares/' '<pi-host>:/var/lib/edicius-hq/migration-input/fares/'
ssh '<pi-host>' 'cd /var/lib/edicius-hq/migration-input/fares && find . -type f -print0 | sort -z | xargs -0 sha256sum' > '<pi-airfare-manifest>'
wc -l '<pc-airfare-manifest>' '<pi-airfare-manifest>'
diff -u '<pc-airfare-manifest>' '<pi-airfare-manifest>'
ssh '<pi-host>' 'sudo chown -R edicius:edicius /var/lib/edicius-hq/migration-input/fares && sudo mv /var/lib/edicius-hq/migration-input/fares /var/lib/edicius-hq/fares'
```

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

The script captures a UTC cutoff separately for Airfare, sentiment, X, and
market. For each collector it starts only that mapping, requires a fresh
owner-scoped `collector_runs` row after its cutoff (`complete` for one-shot
Airfare/sentiment; `running` or `complete` for X/market), checks its
service/timer health, and searches only journald entries since that cutoff.
It stops a failed collector and leaves later mappings disabled. Observe
continuous service/timer status, collector health, rows, and journal errors
for seven days. Retain the unchanged PC data and rollback path throughout that
seven-day PC retention window.

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
