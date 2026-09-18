#!/usr/bin/env bash
# Read-only Pi verification.  Set the documented EDICIUS_VERIFY_RUN_* flags
# only when an operator intentionally wants live provider/remote test runs.
set -euo pipefail

readonly APP_ROOT=/opt/edicius-hq
readonly RELEASES_ROOT="$APP_ROOT/releases"
readonly CURRENT_LINK="$APP_ROOT/current"
readonly STATE_ROOT=/var/lib/edicius-hq
readonly ENV_FILE=/etc/edicius-hq/collectors.env
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
readonly RELEASE_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd -P)"
readonly PYTHON="$CURRENT_LINK/services/api/.venv/bin/python"

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

validate_local_safety() {
  [[ -f "$ENV_FILE" && "$(stat -c '%a' -- "$ENV_FILE")" == 600 ]] || fail "collector environment permissions are unsafe"
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
  if [[ "${EDICIUS_VERIFY_RUN_SENTIMENT:-0}" != 1 ]]; then
    printf '%s\n' 'sentiment live test skipped (set EDICIUS_VERIFY_RUN_SENTIMENT=1 to run it)'
    return
  fi
  set +e
  "$PYTHON" "$CURRENT_LINK/scripts/sentiment-collect.py" 2>&1 | sanitize
  local status=${PIPESTATUS[0]}
  set -e
  [[ "$status" -eq 0 ]] || fail "sentiment live test failed"
}

run_market_document_discovery() {
  if [[ "${EDICIUS_VERIFY_RUN_MARKET:-0}" != 1 ]]; then
    printf '%s\n' 'market document discovery skipped (set EDICIUS_VERIFY_RUN_MARKET=1 to query owner documents)'
    return
  fi
  set +e
  "$PYTHON" -c 'import sys; sys.path.insert(0, "services/api"); from app.services.collector_cloud import configured_collector_cloud; from app.services.market_worker import desired_symbols; cloud = configured_collector_cloud(); docs = cloud.documents(("watchlist", "portfolio", "alert-rules")); cloud.close(); print(f"market documents: {len(docs)}; symbols: {len(desired_symbols(docs))}")' 2>&1 | sanitize
  local status=${PIPESTATUS[0]}
  set -e
  [[ "$status" -eq 0 ]] || fail "market document discovery failed"
}

validate_active_release
validate_local_safety
run_airfare_dry_run
run_sentiment_test
run_market_document_discovery
printf '%s\n' 'verification completed without enabling or starting systemd units.'
