# Pi collector deployment, cutover, and rollback

Use only angle-bracket placeholders in these commands. An exact pinned commit,
not a branch name or `latest`, is activated. No command accepts a secret or
cookie as an argument or prints either.

Every `sh` block in this runbook runs in Git Bash on the Windows operator PC;
PowerShell is used only for the explicitly fenced cutover/rollback commands.

## The only manual actions

All steps are agent/operator executable except the following two actions.

1. **HUMAN-ONLY — securely install `/etc/edicius-hq/collectors.env`.** Create
   the file directly on the Pi through the approved secret channel, with only
   the names required by `ops/pi/install.sh`, owner `root:root`, and mode
   `0600`. Never paste, print, screenshot, or put its values in command
   history.
2. **HUMAN-ONLY — satisfy X login/MFA.** At the approved local Pi console,
   grant the non-login service identity temporary access to the graphical
   session, run Chromium directly as that identity, complete X login/MFA into
   the imported profile, close Chromium, and revoke the display grant. Never
   export its cookies, tokens, or screenshots:

   ```sh
   xhost +SI:localuser:edicius-collector
   sudo -u edicius-collector env HOME=/var/lib/edicius-hq DISPLAY="$DISPLAY" XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}" chromium --user-data-dir=/var/lib/edicius-hq/x-profile https://x.com/thsottiaux
   xhost -SI:localuser:edicius-collector
   ```

## Checkpoint A: pinned data plane

Keep PC source files, the Windows task, and API watcher unchanged. On the
operator checkout, record and verify the exact commit:

```sh
export COMMIT='<40-hex-pinned-commit>'
test "$COMMIT" = "$(git rev-parse "$COMMIT")"
git status --porcelain
```

A credential-injecting operator environment supplies `SUPABASE_ACCESS_TOKEN`
and `SUPABASE_DB_URL`; neither belongs in a command argument, transcript, or
repository file. Docker supplies the available `psql` client. From that exact checkout, apply and verify schema/RLS and
perform idempotent owner bootstrap:

```sh
cd '<pinned-checkout>'
npx supabase link --project-ref '<supabase-project-ref>'
npx supabase db push --linked
npx supabase migration list --linked
test -n "${SUPABASE_DB_URL:-}"
export EDICIUS_OWNER_BOOTSTRAP_ID='<owner-uuid>'
docker run --rm --env SUPABASE_DB_URL --env EDICIUS_OWNER_BOOTSTRAP_ID postgres:16 sh -ceu "psql \"\$SUPABASE_DB_URL\" -X -v ON_ERROR_STOP=1 -v owner_id=\"\$EDICIUS_OWNER_BOOTSTRAP_ID\" -c \"insert into public.edicius_owners(owner_id) values (:'owner_id'::uuid) on conflict do nothing;\" -c \"select owner_id from public.edicius_owners where owner_id = :'owner_id'::uuid;\""
npx supabase test db supabase/tests/collector_data_plane.sql
```

The linked migration list must equal the pinned checkout and the bootstrap
query must return precisely the owner. RLS tests must pass before deployment.

## Checkpoint B: exact Pi release and disabled units

On Debian 13 ARM64, bootstrap the tools, release-local environment, and
Chromium. Debian 13 may provide Python 3.12 or native Python 3.13; the Pi
installer explicitly accepts either, but no other Python version. Node is not
needed on the Pi.

```sh
ssh '<pi-host>' 'sudo apt-get update && sudo apt-get install --yes git rsync chromium python3 python3-venv python3-pip'
ssh '<pi-host>' 'sudo install -d -o root -g root -m 0755 /opt/edicius-hq/releases'
ssh '<pi-host>' "sudo git clone '<repository-url>' /opt/edicius-hq/releases/$COMMIT && sudo git -C /opt/edicius-hq/releases/$COMMIT checkout --detach '$COMMIT'"
ssh '<pi-host>' "test '$COMMIT' = \"\$(sudo git -C /opt/edicius-hq/releases/$COMMIT rev-parse HEAD)\""
ssh '<pi-host>' "sudo python3 -m venv /opt/edicius-hq/releases/$COMMIT/services/api/.venv && sudo /opt/edicius-hq/releases/$COMMIT/services/api/.venv/bin/python -m pip install --upgrade pip && sudo /opt/edicius-hq/releases/$COMMIT/services/api/.venv/bin/python -m pip install --requirement /opt/edicius-hq/releases/$COMMIT/services/api/requirements.txt"
ssh '<pi-host>' "sudo /opt/edicius-hq/releases/$COMMIT/services/api/.venv/bin/python -c 'import sys; raise SystemExit(sys.version_info[:2] not in ((3, 12), (3, 13)))'"
ssh '<pi-host>' "sudo ln -sfn /opt/edicius-hq/releases/$COMMIT /opt/edicius-hq/current"
```

Perform the first manual action now. Only after it is complete, install the
units (the installer intentionally fails without that protected file):

```sh
ssh '<pi-host>' 'sudo /opt/edicius-hq/current/ops/pi/install.sh'
ssh '<pi-host>' 'sudo systemctl is-enabled edicius-airfare.timer edicius-sentiment.timer edicius-tweets.service edicius-market.service'
ssh '<pi-host>' 'sudo systemctl is-enabled edicius-airfare-requests.service'
```

The installer also downloads the Playwright-pinned Chromium build into the
private shared cache used by the X unit and disabled-unit smoke tests.

Each result must be `disabled`. There is no `git pull` at boot and no command
activates a moving branch.

Both one-shot timers also run `OnBootSec=2min`, retain their calendar schedule,
persistent catch-up, and 30-second jitter. Airfare is bounded with
`TimeoutStartSec=20min`: this permits its 15-minute scheduled pass plus small
startup/teardown overhead, while preventing an unbounded one-shot.

## Checkpoint C: durable imports and profile

Every `/var/lib/edicius-hq` destination is created
`0750 edicius-collector:edicius-collector`.
Run the shell blocks below in Git Bash on the Windows operator PC; it provides
`ssh`, `scp`, `sha256sum`, and POSIX shell syntax. They do not require `rsync`
or local `psql`. Each upload first lands in a direct-child `mktemp` directory
owned by the unprivileged SSH account; the Pi helper validates and removes only
that path while installing the fixed private destination. The source PC is
never deleted or overwritten.

Perform app-document import dry-run, apply, then apply again to prove
idempotency; the transient Pi process reads its service-role secret only from
the protected local file. Build a private local staging directory containing
only the allowlisted collector-era documents. Do not copy `.bak` files or the
legacy `finance`/`finance-camera-views` documents: those remain untouched on
the PC and are owned by the earlier Finance migration.

```sh
KV_STAGE="$(mktemp -d)"
for key in prefs watchlist portfolio alert-rules greenlight drawings indicators chart-views airfare-routes greenlight-projector; do
  source_file='<pc-kv-directory>/'"$key.json"
  if test -f "$source_file"; then cp -p "$source_file" "$KV_STAGE/"; fi
done
STAGE="$(ssh '<pi-host>' 'mktemp -d /tmp/edicius-transfer.XXXXXXXX')"
scp -r "$KV_STAGE/." "<pi-host>:$STAGE/"
ssh '<pi-host>' "sudo /opt/edicius-hq/current/ops/pi/install-staged-transfer.sh kv '$STAGE'"
ssh '<pi-host>' "sudo systemd-run --quiet --wait --collect --uid=edicius-collector --property=EnvironmentFile=/etc/edicius-hq/collectors.env --property=WorkingDirectory=/opt/edicius-hq/current /opt/edicius-hq/current/services/api/.venv/bin/python scripts/app-documents-supabase.py --source /var/lib/edicius-hq/migration-input/kv --owner-id '<owner-uuid>'"
ssh '<pi-host>' "sudo systemd-run --quiet --wait --collect --uid=edicius-collector --property=EnvironmentFile=/etc/edicius-hq/collectors.env --property=WorkingDirectory=/opt/edicius-hq/current /opt/edicius-hq/current/services/api/.venv/bin/python scripts/app-documents-supabase.py --source /var/lib/edicius-hq/migration-input/kv --owner-id '<owner-uuid>' --apply"
ssh '<pi-host>' "sudo systemd-run --quiet --wait --collect --uid=edicius-collector --property=EnvironmentFile=/etc/edicius-hq/collectors.env --property=WorkingDirectory=/opt/edicius-hq/current /opt/edicius-hq/current/services/api/.venv/bin/python scripts/app-documents-supabase.py --source /var/lib/edicius-hq/migration-input/kv --owner-id '<owner-uuid>' --apply"
```

Transfer X JSONL/history and its cursor before X is enabled. First start of the
X collector replays this outbox before Chromium opens. Compare file counts and
checksums without printing rows, then make the verified copy durable:

```sh
(cd '<pc-local-data>/tweets' && find . -type f -print0 | sort -z | xargs -0 sha256sum) > '<pc-x-manifest>'
STAGE="$(ssh '<pi-host>' 'mktemp -d /tmp/edicius-transfer.XXXXXXXX')"
scp -r '<pc-local-data>/tweets/.' "<pi-host>:$STAGE/"
ssh '<pi-host>' "sudo sh -c 'cd \"$STAGE\" && find . -type f -print0 | sort -z | xargs -0 sha256sum'" > '<pi-x-manifest>'
wc -l '<pc-x-manifest>' '<pi-x-manifest>'
diff -u '<pc-x-manifest>' '<pi-x-manifest>'
ssh '<pi-host>' "sudo /opt/edicius-hq/current/ops/pi/install-staged-transfer.sh tweets '$STAGE' && sudo mv /var/lib/edicius-hq/migration-input/tweets /var/lib/edicius-hq/tweets"
```

Transfer the Airfare archive, sync cursor, and journals together. It refuses an
existing Pi archive, verifies count/checksum equality, and never truncates
Supabase, the Pi journal, or the PC source:

```sh
(cd '<pc-local-data>/fares' && find . -type f -print0 | sort -z | xargs -0 sha256sum) > '<pc-airfare-manifest>'
STAGE="$(ssh '<pi-host>' 'mktemp -d /tmp/edicius-transfer.XXXXXXXX')"
scp -r '<pc-local-data>/fares/.' "<pi-host>:$STAGE/"
ssh '<pi-host>' "sudo sh -c 'cd \"$STAGE\" && find . -type f -print0 | sort -z | xargs -0 sha256sum'" > '<pi-airfare-manifest>'
wc -l '<pc-airfare-manifest>' '<pi-airfare-manifest>'
diff -u '<pc-airfare-manifest>' '<pi-airfare-manifest>'
ssh '<pi-host>' "sudo /opt/edicius-hq/current/ops/pi/install-staged-transfer.sh fares '$STAGE' && sudo mv /var/lib/edicius-hq/migration-input/fares /var/lib/edicius-hq/fares"
```

Transfer a private profile staging directory with the same privileged path,
then invoke its importer. The importer allows the empty target created by
`install.sh`, but a non-empty different target requires an explicit dated
backup/replace decision:

```sh
STAGE="$(ssh '<pi-host>' 'mktemp -d /tmp/edicius-transfer.XXXXXXXX')"
scp -r '<pc-profile-staging-directory>/.' "<pi-host>:$STAGE/"
ssh '<pi-host>' "sudo /opt/edicius-hq/current/ops/pi/install-staged-transfer.sh x-profile '$STAGE'"
ssh '<pi-host>' 'sudo /opt/edicius-hq/current/ops/pi/import-x-profile.sh --dry-run /var/lib/edicius-hq/migration-input/x-profile'
ssh '<pi-host>' 'sudo /opt/edicius-hq/current/ops/pi/import-x-profile.sh /var/lib/edicius-hq/migration-input/x-profile'
```

Perform the second manual action now. Then run disabled-unit verification and
one-shot tests; no unit is enabled here:

```sh
ssh '<pi-host>' 'sudo /opt/edicius-hq/current/ops/pi/verify.sh'
ssh '<pi-host>' 'sudo /opt/edicius-hq/current/ops/pi/verify.sh --live sentiment'
ssh '<pi-host>' 'sudo /opt/edicius-hq/current/ops/pi/verify.sh --live x-posts'
ssh '<pi-host>' 'sudo /opt/edicius-hq/current/ops/pi/verify.sh --live market'
ssh '<pi-host>' 'sudo systemctl start edicius-airfare.service && sudo systemctl start edicius-sentiment.service'
ssh '<pi-host>' "sudo journalctl -u edicius-airfare.service -u edicius-sentiment.service --since '-15 minutes' --no-pager"
```

Checkpoint C passes when imports are idempotent, source/destination manifests
match, the profile is private, and unit verification/one-shots are healthy.

## Market Broadcast rollout checks

1. Confirm `edicius-market.service` is enabled and active on the Pi.
2. Confirm the deployed commit equals the merged commit.
3. Open Investing and verify the Realtime channel reaches `SUBSCRIBED`.
4. During an active provider move, verify the visible tick arrives within the
   500 ms publication window plus network latency.
5. Query `market_quotes` twice 10 seconds apart and verify `fetched_at` does not
   advance from live ticks; repeat after 60–90 seconds and verify a complete
   snapshot advances.
6. Check Supabase Realtime errors and Disk IO after rollout. Roll back the Pi
   release if private-channel joins fail or snapshot freshness exceeds 90 seconds.

## Manual Airfare request worker activation gate

This branch only prepares the gate. It does not execute these commands against
the Pi or hosted Supabase, and installation leaves
`edicius-airfare-requests.service` disabled. Run this section only after the
pinned schema, release, protected environment, archive import, and disabled-unit
verification above have passed.

First prove the installed unit is disabled, start it without enabling it, and
require a post-start heartbeat. These commands run from the same Git Bash
operator shell used above:

```sh
ssh '<pi-host>' 'test "$(sudo systemctl is-enabled edicius-airfare-requests.service 2>/dev/null || true)" = disabled'
REQUEST_CUTOFF="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ssh '<pi-host>' 'sudo systemctl start edicius-airfare-requests.service'
ssh '<pi-host>' 'sudo systemctl is-active edicius-airfare-requests.service'
ssh '<pi-host>' "sudo /opt/edicius-hq/current/ops/pi/check-collector-run.py airfare-requests --cutoff '$REQUEST_CUTOFF' --wait-seconds 90"
ssh '<pi-host>' "sudo journalctl -u edicius-airfare-requests.service --since '$REQUEST_CUTOFF' --no-pager"
```

For the one manual Airfare canary, open the deployed Airfare page as the owner,
choose a live route/month, and press its circular refresh control once. The
accepted notification must appear, the row must show its spinner/progress, and
the completion notification must appear only after the Pi archive has synced to
Supabase. Record no payload or provider response. In the operator shell, prove
that the owner request completed after sync:

```sh
CANARY_STATE="$(docker run --rm --env SUPABASE_DB_URL --env REQUEST_CUTOFF --env EDICIUS_OWNER_BOOTSTRAP_ID postgres:16 sh -ceu "psql \"\$SUPABASE_DB_URL\" -X -A -t -v ON_ERROR_STOP=1 -v owner_id=\"\$EDICIUS_OWNER_BOOTSTRAP_ID\" -v cutoff=\"\$REQUEST_CUTOFF\" -c \"select status || '|' || (result->>'synced') from public.collector_requests where owner_id = :'owner_id'::uuid and operation = 'airfare-route' and created_at >= :'cutoff'::timestamptz and status = 'complete' and result->>'synced' = 'true' order by created_at desc limit 1;\"")"
test "$CANARY_STATE" = 'complete|true'
```

Before activation, prove stale health removes the control: stop the worker, wait
past the 90-second health window, refresh the Airfare page, and confirm the
circular refresh control is absent while the scheduled-Airfare status remains.
Then explicitly activate only the manual request worker and repeat the heartbeat
check with a new cutoff:

```sh
ssh '<pi-host>' 'sudo systemctl stop edicius-airfare-requests.service'
sleep 91
REQUEST_CUTOFF="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ssh '<pi-host>' 'sudo systemctl enable --now edicius-airfare-requests.service'
ssh '<pi-host>' "sudo /opt/edicius-hq/current/ops/pi/check-collector-run.py airfare-requests --cutoff '$REQUEST_CUTOFF' --wait-seconds 90"
ssh '<pi-host>' 'sudo systemctl is-enabled edicius-airfare-requests.service && sudo systemctl is-active edicius-airfare-requests.service'
```

## Cutover, observation, and rollback

Capture owner-scoped Supabase baseline counts and health for `collector_runs`,
`tweet_posts`, `sentiment_snapshots`, `market_quotes`, and Airfare replica
health before cutover. Save the result outside the repository without secrets.

```powershell
Set-Location '<pinned-checkout>\ops\pi'
.\cutover.ps1 -PiHost '<pi-dns-name>' -WhatIf
.\cutover.ps1 -PiHost '<pi-dns-name>' -LegacyApiBase 'http://127.0.0.1:8000'
```

If the loopback X watcher was never installed and its endpoint returns HTTP
404, use `-LegacyXAbsent` for both the WhatIf and real cutover. The switch
refuses to proceed unless it verifies that condition. If the exact Windows
Airfare task is also absent, add `-LegacyAirfareAbsent`; that condition is
checked independently at preflight and again immediately before Pi Airfare.

The script confirms full disabled Pi preflight and uses read-only
`GET /api/tweets/thsottiaux/refresh` (required HTTP `200` and expected handle)
to prove the local, loopback-only PC API is reachable before changing either PC
collector. At the X gate it issues the exact
`DELETE /api/tweets/thsottiaux/watch` and accepts only its `stopped` or `idle`
HTTP `202` response before repeating the disabled-unit X smoke and enabling Pi
X, so the two Chromium-owning watchers cannot run together. It repeats and
consumes a disabled-unit live smoke immediately before every enable operation,
and gates Sentiment, X, Market, and Airfare in that order.
Immediately before the final Airfare gate it stops the exact Windows task,
waits with a finite deadline until it is no longer running, disables it, and
rechecks both states before running the disabled Airfare service once and then
enabling its timer.
Each UTC-bounded gate requires a fresh owner-scoped `collector_runs` row
(`complete` for one-shots; a post-cutoff heartbeat for workers), service/timer
health, a known sanitized success signal, and no post-cutoff error/fatal/failure
journal output. Success markers use Debian 13's systemd message format, which
includes the unit name (for example, `Started edicius-tweets.service - Edicius X
post collector.`). On a failure it stops that collector and leaves later units
disabled; the PC X watcher remains stopped until a full rollback, including if
the Pi X or market gate fails.
The Airfare journal gate normalizes its successful `, 0 failed,` summary counter
before checking error words. Nonzero failure counts and other errors, including
errors on that same summary line, still fail the gate.

Observe rows, collector health, timers/services, and journal errors for seven
days. Retain unchanged PC data and the rollback path for the full seven-day PC
retention window. If rollback is required, it never deletes or truncates data:

```powershell
Set-Location '<pinned-checkout>\ops\pi'
.\rollback.ps1 -PiHost '<pi-dns-name>' -WhatIf
.\rollback.ps1 -PiHost '<pi-dns-name>' -LegacyApiBase 'http://127.0.0.1:8000'
```

Use the same `-LegacyXAbsent` switch for rollback when cutover used that mode;
rollback then confirms X absence again instead of creating a watcher that did
not exist before the migration. Likewise pass `-LegacyAirfareAbsent` only when
cutover verified no Windows task; rollback rechecks absence rather than creating
a task that did not exist before the migration.

Rollback stops/disables every Pi timer and service and confirms all are
inactive before it restarts the legacy PC X watcher with
`POST /api/tweets/thsottiaux/watch` (required HTTP `202`, expected handle, and
exactly `watching` state).
Only then does it enable the exact Windows airfare task. A failed Pi stop or
PC X restart reports partial rollback and leaves Windows airfare disabled; the
PC X watcher is not restarted until all Pi collectors are confirmed stopped.
Both scripts validate the loopback API base and `-WhatIf` performs no API,
remote, or scheduler mutation.

### Roll back only the manual request worker

This rollback does not change the scheduled collector. It removes the manual
refresh control after the health window while preserving scheduled Airfare data:

```sh
ssh '<pi-host>' 'sudo systemctl disable --now edicius-airfare-requests.service'
ssh '<pi-host>' 'test "$(sudo systemctl is-enabled edicius-airfare-requests.service 2>/dev/null || true)" = disabled'
ssh '<pi-host>' 'test "$(sudo systemctl is-active edicius-airfare-requests.service 2>/dev/null || true)" = inactive'
```
