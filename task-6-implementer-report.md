# Task 6 Implementer Report — completed local collection sync

## Commit

`ca616e89be297da237266158bd999b7559d13e97` (`feat(airfare): replicate completed collection passes`)

## Delivered files

- `services/api/app/services/collection_sync.py` — one bounded, facade-only
  incremental-sync gate shared by board, calendar, and scheduled collection.
- `services/api/app/services/collection_job.py` — board runner finalizes and
  publishes its local pass before awaiting the optional sync.
- `services/api/app/services/calendar_job.py` — calendar runner has the same
  terminal ordering.
- `scripts/fares-collect.py` — scheduled board/calendar invocation finishes
  its local ledger before exactly one eligible sync attempt.
- `services/api/tests/fares/test_fares_endpoint.py` — board ordering,
  failed-report/exception isolation, no-op/failed/partial suppression, and
  concurrent-press coverage.
- `services/api/tests/test_fares_calendar_collect.py` — calendar equivalents,
  including local curve and heartbeat preservation after a failed report.
- `services/api/tests/fares/test_collect_command.py` — scheduled-path ordering
  and facade use.

## Evidence

- RED: the new focused tests initially failed 12/12 because the runners and
  scheduled script had no `AIRFARE_DATA` sync seam.
- GREEN: those 12 focused tests passed after the minimal implementation.
- Airfare runner/data/sync/CLI focused suite: `159 passed in 32.60s`.
- Collection, calendar, pacing, schedule, spend, pass, and CLI suite:
  `127 passed in 22.52s`.
- Full backend suite: `795 passed in 70.50s`.
- `ruff check`: `All checks passed!`
- `ruff format --check`: `7 files already formatted`
- `mypy app ../../scripts/fares-collect.py`: `Success: no issues found in 64
source files`.
- `git diff --check`: clean.

## Self-review

- The only sync call is `AirfareData.sync_incremental()`, so its accepted
  process lock remains the serialization point and no collection path creates a
  remote client.
- A sync is eligible only when at least one local report collected data, every
  report has no failed result, and no report has the existing
  `over-budget`/`pass-window-full` partial-pass reason. No-op, lock-declined,
  provider-failed, partial, cancelled, and runner-failed passes do not sync.
- UI passes record their local ledger, mark their terminal state, and publish
  it before `asyncio.to_thread` awaits sync. The scheduled command records its
  successful ledger before its single sync attempt.
- A failed `SyncReport` logs only fixed dataset names/counts; an unexpected
  exception logs only its class name. Neither reads `error` text, mutates the
  local pass, or exposes credentials.
- Existing cursor coverage already asserts a failed later batch retains the
  first acknowledged offset; no blanket no-advance assertion was added.

## Deviations and notes

- `task-6-brief.md`, `preflight-tasks-6-7.md`, and `progress.md` were not
  present in this worktree or elsewhere under `D:\Work`; implementation used
  the approved migration spec/Task 6 plan and the dispatch's explicit rulings.
- The first full-suite run had one unrelated `BarCache` TTL-zero failure that
  passed in isolated rerun; the fresh final full suite passed all 795 tests.
- Tests use fakes or `httpx.MockTransport`; no test calls live Google Flights
  or Supabase.
