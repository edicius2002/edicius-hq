#!/usr/bin/env bash
# Move one unprivileged, temporary upload into a fixed private collector path.
set -euo pipefail

readonly STATE_ROOT=/var/lib/edicius-hq
fail() { printf '%s\n' "edicius staged transfer: $1" >&2; exit 1; }
[[ "$(id -u)" -eq 0 ]] || fail 'run as root'
[[ $# -eq 2 ]] || fail 'usage: install-staged-transfer.sh KIND STAGE_DIRECTORY'
kind="$1"
stage="$2"

case "$kind" in
  kv|tweets|fares|x-profile) ;;
  *) fail 'unknown transfer kind' ;;
esac
[[ -d "$stage" && ! -L "$stage" ]] || fail 'stage must be a real directory'
stage_real="$(readlink -f -- "$stage")" || fail 'cannot resolve stage'
[[ "$stage_real" == /tmp/edicius-transfer.* ]] || fail 'stage must be under the dedicated temporary root'
[[ "$(dirname -- "$stage_real")" == /tmp ]] || fail 'stage must be a direct child of /tmp'
[[ -z "$(find "$stage_real" -xdev -type l -print -quit)" ]] || fail 'stage contains a symlink'

target="$STATE_ROOT/migration-input/$kind"
[[ ! -e "$target" && ! -L "$target" ]] || fail 'destination already exists'
install -d -o edicius -g edicius -m 0750 "$STATE_ROOT/migration-input"
install -d -o edicius -g edicius -m 0750 "$target"
cp -a -- "$stage_real/." "$target/"
chown -R edicius:edicius "$target"
find "$target" -type d -exec chmod 0750 {} +
rm -rf -- "$stage_real"
printf '%s\n' "staged $kind transfer installed privately"
