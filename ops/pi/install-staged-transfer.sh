#!/usr/bin/env bash
# Move one unprivileged, temporary upload into a fixed private collector path.
set -euo pipefail

readonly STATE_ROOT=/var/lib/edicius-hq
readonly MIGRATION_ROOT="$STATE_ROOT/migration-input"
readonly SERVICE_USER=edicius-collector
fail() { printf '%s\n' "edicius staged transfer: $1" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail 'run as root'
[[ $# -eq 2 ]] || fail 'usage: install-staged-transfer.sh KIND STAGE_DIRECTORY'
kind="$1"
stage="$2"

case "$kind" in
  kv|tweets|fares|x-profile) ;;
  *) fail 'unknown transfer kind' ;;
esac
[[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || fail 'state root must be a real directory'
state_root_real="$(readlink -f -- "$STATE_ROOT")" || fail 'cannot resolve state root'
[[ "$state_root_real" == "$STATE_ROOT" ]] || fail 'state root escaped its required path'
if [[ -e "$MIGRATION_ROOT" || -L "$MIGRATION_ROOT" ]]; then
  [[ -d "$MIGRATION_ROOT" && ! -L "$MIGRATION_ROOT" ]] || fail 'migration root must be a real directory'
else
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$MIGRATION_ROOT"
fi
migration_root_real="$(readlink -f -- "$MIGRATION_ROOT")" || fail 'cannot resolve migration root'
[[ "$migration_root_real" == "$state_root_real/migration-input" ]] || fail 'migration root escaped durable state'
[[ -d "$stage" && ! -L "$stage" ]] || fail 'stage must be a real directory'
stage_real="$(readlink -f -- "$stage")" || fail 'cannot resolve stage'
[[ "$stage_real" == /tmp/edicius-transfer.* ]] || fail 'stage must be under the dedicated temporary root'
[[ "$(dirname -- "$stage_real")" == /tmp ]] || fail 'stage must be a direct child of /tmp'
[[ -z "$(find "$stage_real" -xdev -type l -print -quit)" ]] || fail 'stage contains a symlink'

target="$migration_root_real/$kind"
[[ ! -e "$target" && ! -L "$target" ]] || fail 'destination already exists'
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$target"
target_real="$(readlink -f -- "$target")" || fail 'cannot resolve destination'
[[ "$target_real" == "$migration_root_real/$kind" ]] || fail 'destination escaped migration root'
cp -a -- "$stage_real/." "$target_real/"
chown -R "$SERVICE_USER:$SERVICE_USER" "$target_real"
find "$target_real" -type d -exec chmod 0750 {} +
find "$target_real" -type f -exec chmod 0600 {} +
rm -rf -- "$stage_real"
printf '%s\n' "staged $kind transfer installed privately"
