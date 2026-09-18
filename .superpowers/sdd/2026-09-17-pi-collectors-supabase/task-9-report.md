# Task 9 — Raspberry Pi systemd package

## Delivered

- Six disabled-by-default systemd artifacts: two persistent, jittered timers
  for Airfare and sentiment, plus restart-on-failure X and market workers.
- `install.sh`, which validates Debian 13 ARM64, the active exact Git release,
  Python 3.12, a root-owned `0600` collector environment, Chromium, and
  writable `edicius` state before it copies units and reloads systemd. It does
  not enable or start units and never writes the secret file.
- `verify.sh`, which verifies the exact active release, unit syntax, protected
  secret permissions, and a non-empty X Chromium cookie database. Its Airfare
  dry run uses the local watch cache, so it has no provider or remote-data-plane
  request. Sentiment and market document checks are explicitly opt-in with
  `EDICIUS_VERIFY_RUN_SENTIMENT=1` and `EDICIUS_VERIFY_RUN_MARKET=1`.

## TDD evidence

- RED: `services/api/.venv/Scripts/python.exe -m pytest ../../ops/pi/tests/test_units.py -q`
  failed with 16 missing systemd-artifact failures.
- GREEN: the same command passed: `16 passed`.

## Verification

- `bash -n ops/pi/install.sh ops/pi/verify.sh` passed.
- `npm run lint:api` passed.
- `npm run typecheck:api` passed (78 source files; one existing mypy note for
  `scripts/measure_airfare_browser.py`).
- `git diff --cached --check` passed.
- ShellCheck is not installed in this Windows workspace.

## Review notes

- The units use only `/opt/edicius-hq/current` for release code and
  `/var/lib/edicius-hq` for mutable files; no listener or automatic Git update
  is introduced.
- Installer/systemd execution and live verification were intentionally not run
  on Windows or against a Pi.
