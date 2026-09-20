# Task 10 report — Pi collector cutover runbooks

## Delivered

- Added an operator runbook covering pinned deployment, schema/RLS and owner
  bootstrap, document/X/Airfare migration, disabled-unit and one-shot gates,
  row/health comparison, ordered cutover, seven-day PC retention, observation,
  and non-destructive rollback.
- Added guarded Windows cutover and rollback scripts. Both require the exact
  `Edicius airfare` task; cutover verifies the Pi before disabling it, while
  rollback confirms Pi units are stopped before re-enabling it.
- Added a profile importer with dry-run support, symlink/path-escape checks,
  idempotent no-op detection, explicit backup-before-replace, and restrictive
  ownership/modes.

## Safety review

- The runbook has exactly two labelled manual actions: protected secret-file
  installation and X login/MFA. No command includes real credentials, cookies,
  owner IDs, or project IDs.
- Scripts use strict modes, fixed unit/task names, validated Pi host input,
  and `WhatIf`/dry-run paths. They contain no deletion/truncation operations.
- Cutover requires disabled installed Pi units and stops at the first Pi health
  failure; the runbook retains the PC source for seven days and calls for
  Supabase row/health comparison after each collector enablement.

## Verification evidence

On 2026-09-18, before commit:

```text
services/api/.venv/Scripts/python.exe -m pytest ops/pi/tests/test_units.py ops/pi/tests/test_runbooks.py -q
28 passed in 0.06s

bash -n ops/pi/import-x-profile.sh
PowerShell Parser::ParseFile for cutover.ps1 and rollback.ps1
git diff --check
```

No Pi, production service, scheduler, ledger, or data was accessed or changed.
