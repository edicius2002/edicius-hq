#!/usr/bin/env bash
# Stage an exact release before pausing collectors. Run through deploy.ps1.
set -euo pipefail

commit="${1:-}"
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full lowercase commit SHA.' >&2; exit 2; }
[[ "$(id -u)" -eq 0 ]] || { echo 'Run this script through sudo.' >&2; exit 2; }

readonly app_root=/opt/edicius-hq
readonly current_link="$app_root/current"
readonly release="$app_root/releases/$commit"
readonly repository=https://github.com/edicius2002/edicius-hq.git
readonly lock_path=/var/lib/edicius-hq/locks/airfare.lock
readonly previous_release="$(readlink -f -- "$current_link")"
[[ "$previous_release" == "$app_root/releases/"* && -d "$previous_release" ]] || {
  echo 'The active Pi release is not a valid pinned release.' >&2
  exit 1
}

workers=(edicius-airfare-requests.service edicius-tweets.service edicius-market.service)
timers=(edicius-airfare.timer edicius-sentiment.timer)
# Collectors activated after their first release; pause them only once enabled.
optional_timers=(edicius-fx.timer)
for unit in "${optional_timers[@]}"; do
  if [[ "$(systemctl is-enabled "$unit" 2>/dev/null || true)" == enabled ]]; then
    timers+=("$unit")
  fi
done
paused=0
switched=0

# An older release has no unit or script for a newer timer; leave it stopped.
drop_timers_missing_from() {
  local root="$1" unit kept=()
  for unit in "${timers[@]}"; do
    if [[ -e "$root/ops/pi/systemd/$unit" ]]; then
      kept+=("$unit")
    else
      echo "Leaving $unit stopped; the restored release does not ship it." >&2
    fi
  done
  timers=("${kept[@]}")
}

restore_previous_release() {
  local status=$?
  trap - EXIT
  if (( status != 0 && paused == 1 )); then
    echo 'Deployment failed; restoring the previous release and collector services.' >&2
    if (( switched == 1 )); then
      if ! systemctl stop "${workers[@]}" "${timers[@]}"; then
        echo 'Could not stop every new collector unit; keeping the new release link for manual recovery.' >&2
        systemctl start "${workers[@]}" "${timers[@]}" || true
        exit "$status"
      fi
      ln -sfn -- "$previous_release" "$current_link" || echo 'Could not restore the release link.' >&2
      "$previous_release/ops/pi/install.sh" || echo 'Could not reinstall the previous units.' >&2
      drop_timers_missing_from "$previous_release"
    fi
    systemctl start "${workers[@]}" "${timers[@]}" || echo 'Could not restart every collector unit.' >&2
  fi
  exit "$status"
}
trap restore_previous_release EXIT

echo "Preparing Pi release $commit"
if [[ ! -e "$release" ]]; then
  git clone "$repository" "$release"
  git -C "$release" checkout --detach "$commit"
fi
[[ -d "$release/.git" ]] || { echo 'Release directory is not a Git checkout.' >&2; exit 1; }
[[ "$(git -C "$release" rev-parse HEAD)" == "$commit" ]] || {
  echo 'Release directory contains a different commit.' >&2
  exit 1
}
[[ -z "$(git -C "$release" status --porcelain --untracked-files=all)" ]] || {
  echo 'Release checkout is not clean.' >&2
  exit 1
}

if [[ "$previous_release" == "$release" ]]; then
  for unit in "${workers[@]}" "${timers[@]}"; do
    systemctl is-active --quiet "$unit" || { echo "$unit is not active." >&2; exit 1; }
  done
  echo "Pi is already on $commit"
  exit 0
fi

python3 -m venv "$release/services/api/.venv"
"$release/services/api/.venv/bin/python" -m pip install --upgrade pip
"$release/services/api/.venv/bin/python" -m pip install --requirement "$release/services/api/requirements.txt"
"$release/services/api/.venv/bin/python" -c 'import sys; raise SystemExit(sys.version_info[:2] not in ((3, 12), (3, 13)))'
[[ -z "$(git -C "$release" status --porcelain --untracked-files=all)" ]] || {
  echo 'Prepared release checkout is not clean.' >&2
  exit 1
}

for unit in "${workers[@]}" "${timers[@]}"; do
  [[ "$(systemctl is-enabled "$unit")" == enabled ]] || {
    echo "Expected $unit to be enabled before deployment." >&2
    exit 1
  }
done

echo 'Waiting for scheduled collector passes to finish.'
paused=1
systemctl stop "${timers[@]}"
deadline=$((SECONDS + 1200))
for timer in "${timers[@]}"; do
  service="${timer%.timer}.service"
  while [[ "$(systemctl show --property=ActiveState --value "$service")" != inactive ]]; do
    state="$(systemctl show --property=ActiveState --value "$service")"
    [[ "$state" != failed ]] || break
    (( SECONDS < deadline )) || { echo "Timed out waiting for $service." >&2; exit 1; }
    sleep 5
  done
done

# Hold the same lock as manual Airfare work while stopping its worker.
flock -n "$lock_path" systemctl stop edicius-airfare-requests.service || {
  echo 'A manual Airfare fetch is running; retry after it finishes.' >&2
  exit 1
}
systemctl stop edicius-tweets.service edicius-market.service

switched=1
ln -sfn -- "$release" "$current_link"
"$release/ops/pi/install.sh"
"$release/ops/pi/verify.sh"
systemctl start "${workers[@]}" "${timers[@]}"

[[ "$(readlink -f -- "$current_link")" == "$release" ]]
for unit in "${workers[@]}" "${timers[@]}"; do
  systemctl is-active --quiet "$unit" || { echo "$unit did not become active." >&2; exit 1; }
done
echo "Pi deployment verified: $commit"
