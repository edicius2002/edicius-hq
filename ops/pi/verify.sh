#!/usr/bin/env bash
# Read-only Pi verification.  Only the explicit --live invocation runs the
# sentiment provider/upsert check; the default never starts a collector.
set -euo pipefail

readonly APP_ROOT=/opt/edicius-hq
readonly RELEASES_ROOT="$APP_ROOT/releases"
readonly CURRENT_LINK="$APP_ROOT/current"
readonly STATE_ROOT=/var/lib/edicius-hq
readonly ENV_FILE=/etc/edicius-hq/collectors.env
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly PYTHON="$CURRENT_LINK/services/api/.venv/bin/python"
readonly LIVE="${1:-}"
readonly REQUIRED_ENV_NAMES=(SUPABASE_URL SUPABASE_SECRET_KEY EDICIUS_OWNER_ID COLLECTOR_SUPABASE_TIMEOUT_SECONDS AIRFARE_DATA_BACKEND AIRFARE_SYNC_ENABLED)

fail() {
  printf '%s\n' "edicius Pi verify: $1" >&2
  exit 1
}

sanitize() {
  sed -E 's/(sb_secret|eyJ)[[:alnum:]_.-]+/[redacted]/g; s#https://[^[:space:]]+#https://[redacted]#g'
}

validate_active_release() {
  [[ -L "$CURRENT_LINK" ]] || fail "active release symlink is required"
  local active commit expected
  active="$(readlink -f -- "$CURRENT_LINK")" || fail "cannot resolve active release"
  [[ -d "$active/.git" || -f "$active/.git" ]] || fail "active release is not a Git checkout"
  commit="$(git -C "$active" rev-parse HEAD)" || fail "cannot resolve active commit"
  expected="$RELEASES_ROOT/$commit"
  [[ "$active" == "$expected" ]] || fail "active release directory does not match its exact commit"
  [[ "$RELEASE_DIR" == "$active" ]] || fail "verify script is not running from the active release"
  [[ -x "$PYTHON" ]] || fail "active release Python virtualenv is missing"
  printf '%s\n' "active commit: ${commit:0:12}"
}

validate_env() {
  [[ -f "$ENV_FILE" && ! -L "$ENV_FILE" ]] || fail "collector environment file must be a regular file"
  [[ "$(stat -c '%u' -- "$ENV_FILE")" == 0 ]] || fail "collector environment file must be owned by root"
  [[ "$(stat -c '%a' -- "$ENV_FILE")" == 600 ]] || fail "collector environment file must have mode 0600"
  local -A required=([SUPABASE_URL]=1 [SUPABASE_SECRET_KEY]=1 [EDICIUS_OWNER_ID]=1 [COLLECTOR_SUPABASE_TIMEOUT_SECONDS]=1 [AIRFARE_DATA_BACKEND]=1 [AIRFARE_SYNC_ENABLED]=1)
  local line name value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    [[ "$line" == *=* ]] || fail "collector environment file has an invalid variable declaration"
    name="${line%%=*}"
    value="${line#*=}"
    [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ && "${required[$name]-}" == 1 ]] || fail "collector environment file has an unexpected variable name"
    [[ -n "$value" ]] || fail "collector environment file has an empty required value"
    required["$name"]=0
  done < "$ENV_FILE"
  for name in "${REQUIRED_ENV_NAMES[@]}"; do
    [[ "${required[$name]}" == 0 ]] || fail "collector environment file is missing a required variable"
  done
}

load_env() {
  local line name value
  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" || "$line" == \#* ]] && continue
    name="${line%%=*}"
    value="${line#*=}"
    export "$name=$value"
  done < "$ENV_FILE"
}

validate_local_safety() {
  [[ -d "$STATE_ROOT/x-profile" ]] || fail "X profile directory is missing"
  local cookie_file
  cookie_file="$(find "$STATE_ROOT/x-profile" -type f -name Cookies -size +0c -print -quit)"
  [[ -n "$cookie_file" ]] || fail "X profile has no Chromium cookie database"
  systemd-analyze verify "$SCRIPT_DIR/systemd/edicius-airfare.service" "$SCRIPT_DIR/systemd/edicius-airfare.timer" "$SCRIPT_DIR/systemd/edicius-sentiment.service" "$SCRIPT_DIR/systemd/edicius-sentiment.timer" "$SCRIPT_DIR/systemd/edicius-tweets.service" "$SCRIPT_DIR/systemd/edicius-market.service"
}

run_airfare_dry_run() {
  # The local rollback cache makes this a true dry run: no provider or remote
  # data-plane request is made by a command whose purpose is only inspection.
  "$PYTHON" "$CURRENT_LINK/scripts/fares-collect.py" --watch-source local --dry-run 2>&1 | sanitize
}

run_sentiment_test() {
  set +e
  "$PYTHON" "$CURRENT_LINK/scripts/sentiment-collect.py" 2>&1 | sanitize
  local status=${PIPESTATUS[0]}
  set -e
  [[ "$status" -eq 0 ]] || fail "sentiment live test failed"
}

run_market_document_discovery() {
  set +e
  "$PYTHON" -c 'import sys; sys.path.insert(0, "services/api"); from app.services.collector_cloud import configured_collector_cloud; from app.services.market_worker import desired_symbols; cloud = configured_collector_cloud(); docs = cloud.documents(("watchlist", "portfolio", "alert-rules")); cloud.close(); print(f"market documents: {len(docs)}; symbols: {len(desired_symbols(docs))}")' 2>&1 | sanitize
  local status=${PIPESTATUS[0]}
  set -e
  [[ "$status" -eq 0 ]] || fail "market document discovery failed"
}

[[ $# -le 1 && ( -z "$LIVE" || "$LIVE" == --live ) ]] || fail "usage: verify.sh [--live]"
validate_active_release
validate_env
load_env
export LOCAL_DATA_DIR="$STATE_ROOT"
cd -- "$CURRENT_LINK"
validate_local_safety
run_airfare_dry_run
run_market_document_discovery
if [[ "$LIVE" == --live ]]; then
  run_sentiment_test
else
  printf '%s\n' 'sentiment live test skipped (rerun with --live to run it)'
fi
printf '%s\n' 'verification completed without enabling or starting systemd units.'
