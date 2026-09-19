#!/usr/bin/env bash
# Install the checked-out, pinned Pi collector units.  This script never starts
# or enables a collector; cutover is an explicit operator action.
set -euo pipefail

readonly APP_ROOT=/opt/edicius-hq
readonly RELEASES_ROOT="$APP_ROOT/releases"
readonly CURRENT_LINK="$APP_ROOT/current"
readonly STATE_ROOT=/var/lib/edicius-hq
readonly BROWSER_ROOT=/var/cache/edicius-hq/playwright
readonly ENV_FILE=/etc/edicius-hq/collectors.env
readonly UNIT_DIR=/etc/systemd/system
readonly SERVICE_USER=edicius-collector
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly PYTHON="$CURRENT_LINK/services/api/.venv/bin/python"

fail() {
  printf '%s\n' "edicius Pi install: $1" >&2
  exit 1
}

require_root() {
  [[ "$(id -u)" -eq 0 ]] || fail "run as root"
}

validate_platform() {
  [[ -r /etc/os-release ]] || fail "Debian 13 is required"
  # shellcheck disable=SC1091
  . /etc/os-release
  [[ "${ID:-}" == debian && "${VERSION_ID:-}" == 13 ]] || fail "Debian 13 is required"
  [[ "$(dpkg --print-architecture)" == arm64 ]] || fail "ARM64 is required"
}

validate_release() {
  [[ -d "$RELEASE_DIR/.git" || -f "$RELEASE_DIR/.git" ]] || fail "release must be a tested Git checkout"
  local commit expected active
  commit="$(git -C "$RELEASE_DIR" rev-parse HEAD)" || fail "cannot resolve release commit"
  [[ -z "$(git -C "$RELEASE_DIR" status --porcelain --untracked-files=all)" ]] || fail "release checkout is not clean"
  expected="$RELEASES_ROOT/$commit"
  [[ "$RELEASE_DIR" == "$expected" ]] || fail "release directory does not match its exact commit"
  [[ -L "$CURRENT_LINK" ]] || fail "active release symlink is required"
  active="$(readlink -f -- "$CURRENT_LINK")" || fail "cannot resolve active release"
  [[ "$active" == "$expected" ]] || fail "active release is not this exact tested commit"
  [[ -x "$RELEASE_DIR/services/api/.venv/bin/python" ]] || fail "release Python virtualenv is missing"
  "$RELEASE_DIR/services/api/.venv/bin/python" -c 'import sys; raise SystemExit(sys.version_info[:2] not in ((3, 12), (3, 13)))' || fail "Python 3.12 or 3.13 is required"
}

validate_env() {
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "collector environment file must be a regular file"
  [[ "$(stat -c '%a' -- "$ENV_FILE")" == 600 ]] || fail "collector environment file must have mode 0600"
  [[ "$(stat -c '%u' -- "$ENV_FILE")" == 0 ]] || fail "collector environment file must be owned by root"
  local -A required=([SUPABASE_URL]=1 [SUPABASE_SECRET_KEY]=1 [EDICIUS_OWNER_ID]=1 [COLLECTOR_SUPABASE_TIMEOUT_SECONDS]=1 [AIRFARE_DATA_BACKEND]=1 [AIRFARE_SYNC_ENABLED]=1)
  local line name value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fail "collector environment file has an invalid variable declaration"
    name="${line%%=*}"
    value="${line#*=}"
    [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ && -n "${required[$name]+x}" ]] || fail "collector environment file has an unexpected variable name"
    [[ -n "$value" ]] || fail "collector environment file has an empty required value"
    required["$name"]=0
  done < "$ENV_FILE"
  for name in "${!required[@]}"; do
    [[ "${required[$name]}" == 0 ]] || fail "collector environment file is missing a required variable"
  done
}

ensure_runtime() {
  if ! getent passwd "$SERVICE_USER" >/dev/null; then
    useradd --system --user-group --home-dir "$STATE_ROOT" --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  local shell
  shell="$(getent passwd "$SERVICE_USER" | awk -F: '{print $7}')"
  [[ "$shell" == /usr/sbin/nologin || "$shell" == /sbin/nologin ]] || fail "$SERVICE_USER must be a non-login account"
  command -v chromium >/dev/null || fail "Chromium must be installed"
  [[ ! -L "$STATE_ROOT" ]] || fail "$STATE_ROOT must not be a symlink"
  [[ ! -e "$STATE_ROOT" || -d "$STATE_ROOT" ]] || fail "$STATE_ROOT must be a directory"
  install -d -o root -g "$SERVICE_USER" -m 0750 "$STATE_ROOT"
  [[ -z "$(find "$STATE_ROOT" -xdev -type l -print -quit)" ]] || fail "durable state contains a symlink"
  chown -R --no-dereference "$SERVICE_USER:$SERVICE_USER" "$STATE_ROOT"
  find "$STATE_ROOT" -xdev -type d -exec chmod 0750 {} +
  find "$STATE_ROOT" -xdev -type f -exec chmod 0600 {} +
  chown root:"$SERVICE_USER" "$STATE_ROOT"
  for runtime_dir in x-profile kv bars sentiment codex-resets; do
    install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$STATE_ROOT/$runtime_dir"
  done
  [[ ! -L "$STATE_ROOT/locks" ]] || fail "$STATE_ROOT/locks must not be a symlink"
  [[ ! -e "$STATE_ROOT/locks" || -d "$STATE_ROOT/locks" ]] || fail "$STATE_ROOT/locks must be a directory"
  install -d -o root -g "$SERVICE_USER" -m 0750 "$STATE_ROOT/locks"
  [[ "$(stat -c '%U:%G:%a' -- "$STATE_ROOT/locks")" == root:$SERVICE_USER:750 ]] || fail "lock directory owner or mode is invalid"
  local lock_name lock_path
  for lock_name in airfare sentiment tweets market; do
    lock_path="$STATE_ROOT/locks/$lock_name.lock"
    [[ ! -L "$lock_path" ]] || fail "$lock_path must not be a symlink"
    if [[ ! -e "$lock_path" ]]; then
      install -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0600 /dev/null "$lock_path"
    fi
    [[ -f "$lock_path" && ! -L "$lock_path" ]] || fail "$lock_path must be a regular file"
    chown "$SERVICE_USER:$SERVICE_USER" "$lock_path"
    chmod 0600 "$lock_path"
    [[ "$(stat -c '%U:%G:%a' -- "$lock_path")" == $SERVICE_USER:$SERVICE_USER:600 ]] || fail "$lock_path owner or mode is invalid"
  done
  runuser -u "$SERVICE_USER" -- test -w "$STATE_ROOT/x-profile" || fail "durable state is not writable by $SERVICE_USER"
  [[ ! -L /var/cache/edicius-hq ]] || fail "browser cache parent must not be a symlink"
  [[ ! -e /var/cache/edicius-hq || -d /var/cache/edicius-hq ]] || fail "browser cache parent must be a directory"
  install -d -o root -g root -m 0755 /var/cache/edicius-hq
  [[ ! -L "$BROWSER_ROOT" ]] || fail "Playwright browser cache must not be a symlink"
  [[ ! -e "$BROWSER_ROOT" || -d "$BROWSER_ROOT" ]] || fail "Playwright browser cache must be a directory"
  install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0750 "$BROWSER_ROOT"
  runuser -u "$SERVICE_USER" -- env HOME="$STATE_ROOT" PLAYWRIGHT_BROWSERS_PATH="$BROWSER_ROOT" \
    "$PYTHON" -m playwright install chromium \
    || fail "Playwright Chromium installation failed"
}

install_units() {
  local unit
  for unit in edicius-airfare.service edicius-airfare.timer edicius-sentiment.service edicius-sentiment.timer edicius-tweets.service edicius-market.service; do
    install -m 0644 "$RELEASE_DIR/ops/pi/systemd/$unit" "$UNIT_DIR/$unit"
  done
  systemctl daemon-reload
}

require_root
validate_platform
validate_release
validate_env
ensure_runtime
install_units
printf '%s\n' 'edicius Pi units installed; no units were enabled or started.'
