#!/usr/bin/env bash
# Complete a pinned Neon collector cutover after the operator supplies sudo.
# The staged URL and deploy script are copied over SSH by the operator PC.
set -euo pipefail

commit="${1:-}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full commit SHA.' >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo 'Run this script through sudo.' >&2; exit 2; }

readonly operator_home=/home/edicius
readonly url_file="$operator_home/.edicius-neon-url-$commit"
readonly deploy_script="$operator_home/.edicius-deploy-release-$commit.sh"
readonly env_file=/etc/edicius-hq/collectors.env
readonly backup="$env_file.pre-neon-$commit"

[[ -f "$url_file" && ! -L "$url_file" ]] || { echo 'Staged Neon URL is missing.' >&2; exit 1; }
[[ "$(stat -c '%U:%a' -- "$url_file")" == edicius:600 ]] || {
  echo 'Staged Neon URL ownership or mode is invalid.' >&2; exit 1;
}
[[ -f "$deploy_script" && ! -L "$deploy_script" ]] || {
  echo 'Staged release script is missing.' >&2; exit 1;
}
[[ "$(stat -c '%U:%a' -- "$deploy_script")" == edicius:600 ]] || {
  echo 'Staged release script ownership or mode is invalid.' >&2; exit 1;
}
[[ -f "$env_file" && ! -L "$env_file" ]] || { echo 'Collector environment is missing.' >&2; exit 1; }
[[ "$(stat -c '%u:%a' -- "$env_file")" == 0:600 ]] || {
  echo 'Collector environment ownership or mode is invalid.' >&2; exit 1;
}
[[ ! -e "$backup" ]] || { echo 'Cutover backup already exists.' >&2; exit 1; }

# Stop new scheduled passes before changing the service environment. Running
# oneshot passes keep the old environment they already inherited; the pinned
# deploy script waits for them to finish before switching the release.
units=(
  edicius-airfare.timer edicius-airfare-sync.timer edicius-sentiment.timer
  edicius-fx.timer edicius-seace-scheduled.timer edicius-seace-notices.timer
  edicius-seace-requests.timer edicius-retention.timer
  edicius-airfare-requests.service edicius-tweets.service edicius-market.service
)
active_units=()
for unit in "${units[@]}"; do
  if systemctl is-active --quiet "$unit"; then active_units+=("$unit"); fi
done

backup_ready=0
deployed=0
restore_on_failure() {
  local status=$?
  trap - EXIT
  if (( status != 0 && deployed == 0 )); then
    if (( backup_ready == 1 )); then
      cp -p -- "$backup" "$env_file" || echo 'Could not restore collector environment.' >&2
    fi
    if (( ${#active_units[@]} > 0 )); then
      systemctl start "${active_units[@]}" || echo 'Could not restart every prior unit.' >&2
    fi
  fi
  exit "$status"
}
trap restore_on_failure EXIT

if (( ${#active_units[@]} > 0 )); then systemctl stop "${active_units[@]}"; fi
cp -p -- "$env_file" "$backup"
backup_ready=1

python3 - "$url_file" "$env_file" <<'PY'
import os
import re
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlsplit

url_file, env_file = map(Path, sys.argv[1:])
url = url_file.read_text(encoding='utf-8').strip()
try:
    parsed = urlsplit(url)
    valid = (
        '\n' not in url and '\r' not in url and not any(c.isspace() for c in url)
        and parsed.scheme in {'postgres', 'postgresql'}
        and bool(parsed.hostname and parsed.hostname.endswith('.neon.tech'))
        and '-pooler' in (parsed.hostname or '')
        and bool(parsed.username and parsed.password and parsed.path.strip('/'))
    )
except ValueError:
    valid = False
if not valid:
    raise SystemExit('Staged Neon URL is invalid.')

updates = {
    'DATABASE_URL': url,
    'COLLECTOR_DATA_BACKEND': 'neon',
    'AIRFARE_SYNC_BACKEND': 'neon',
    'AIRFARE_SYNC_ENABLED': 'true',
    'AIRFARE_DATA_BACKEND': 'local',
}
retained = []
seen = set()
for line in env_file.read_text(encoding='utf-8').splitlines():
    if not line or line.startswith('#'):
        retained.append(line)
        continue
    name, separator, value = line.partition('=')
    if not separator or not re.fullmatch(r'[A-Z][A-Z0-9_]*', name) or not value:
        raise SystemExit('Existing collector environment is malformed.')
    if name in seen:
        raise SystemExit('Existing collector environment has duplicate names.')
    seen.add(name)
    if name not in updates:
        retained.append(line)

content = '\n'.join(retained + [f'{name}={value}' for name, value in updates.items()]) + '\n'
fd, temporary = tempfile.mkstemp(prefix='.collectors-neon-', dir=env_file.parent)
try:
    os.fchmod(fd, 0o600)
    with os.fdopen(fd, 'w', encoding='utf-8') as stream:
        stream.write(content)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, env_file)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
PY

bash "$deploy_script" "$commit"
deployed=1
rm -f -- "$url_file"
systemctl start edicius-airfare-sync.service
[[ "$(systemctl show --property=Result --value edicius-airfare-sync.service)" == success ]] || {
  echo 'Airfare sync service did not complete successfully.' >&2; exit 1;
}
echo "Neon Pi cutover completed for $commit"
