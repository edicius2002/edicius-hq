#!/usr/bin/env bash
# Import a copied Chromium X profile into the Pi's private durable state.
set -euo pipefail

readonly STATE_ROOT=/var/lib/edicius-hq
readonly TARGET="$STATE_ROOT/x-profile"
readonly TARGET_PARENT="$STATE_ROOT"
readonly BACKUP_ROOT="$STATE_ROOT/x-profile-backups"

fail() { printf '%s\n' "edicius X profile import: $1" >&2; exit 1; }
usage() { printf '%s\n' 'usage: import-x-profile.sh [--dry-run] [--replace-with-backup] SOURCE_DIRECTORY' >&2; exit 2; }

dry_run=false
replace=false
source_path=''
while (($#)); do
  case "$1" in
    --dry-run) dry_run=true ;;
    --replace-with-backup) replace=true ;;
    --help) usage ;;
    -*) usage ;;
    *) [[ -z "$source_path" ]] || usage; source_path="$1" ;;
  esac
  shift
done
[[ -n "$source_path" ]] || usage
[[ "$(id -u)" -eq 0 ]] || fail 'run as root'
[[ -d "$STATE_ROOT" && ! -L "$STATE_ROOT" ]] || fail 'durable state root must be a real directory'
[[ -d "$source_path" && ! -L "$source_path" ]] || fail 'source must be a real directory, not a symlink'

source_real="$(readlink -f -- "$source_path")" || fail 'cannot resolve source'
target_parent_real="$(readlink -f -- "$TARGET_PARENT")" || fail 'cannot resolve durable state root'
[[ "$target_parent_real" == "$STATE_ROOT" ]] || fail 'durable state root escaped its required path'
[[ "$source_real" != "$TARGET" && "$source_real" != "$TARGET/"* ]] || fail 'source must not be the live target'
[[ -z "$(find "$source_real" -xdev -type l -print -quit)" ]] || fail 'source contains a symlink'

if systemctl is-active --quiet edicius-tweets.service; then
  fail 'stop the X collector before importing its profile'
fi

if [[ -e "$TARGET" || -L "$TARGET" ]]; then
  [[ ! -L "$TARGET" && -d "$TARGET" ]] || fail 'existing target is unsafe'
  [[ -z "$(find "$TARGET" -xdev -type l -print -quit)" ]] || fail 'existing target contains a symlink'
  if diff -qr --no-dereference -- "$source_real" "$TARGET" >/dev/null; then
    printf '%s\n' 'X profile is already imported; no change was made.'
    exit 0
  fi
  [[ "$replace" == true ]] || fail 'live target exists; rerun with --replace-with-backup after making a backup decision'
fi

if [[ "$dry_run" == true ]]; then
  printf '%s\n' 'dry run: source and target safety checks passed; no profile was copied.'
  exit 0
fi

install -d -o edicius -g edicius -m 0750 "$BACKUP_ROOT"
stage="$(mktemp -d "$TARGET_PARENT/.x-profile-stage.XXXXXXXX")" || fail 'cannot create staging directory'
trap 'rmdir -- "$stage" 2>/dev/null || true' EXIT
cp -a -- "$source_real/." "$stage/"
[[ -z "$(find "$stage" -xdev -type l -print -quit)" ]] || fail 'copied profile contains a symlink'
chown -R edicius:edicius "$stage"
chmod -R go-rwx "$stage"

if [[ -d "$TARGET" ]]; then
  backup="$BACKUP_ROOT/x-profile.$(date -u +%Y%m%dT%H%M%SZ)"
  [[ ! -e "$backup" && ! -L "$backup" ]] || fail 'backup name already exists'
  mv -- "$TARGET" "$backup"
fi
mv -- "$stage" "$TARGET"
trap - EXIT
printf '%s\n' 'X profile imported with private ownership and modes; no profile data was printed.'
