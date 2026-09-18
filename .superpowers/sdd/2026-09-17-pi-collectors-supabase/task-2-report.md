# Task 2 report — Supabase application documents

## Delivered

- Added `shared/storage/supabaseStorage.ts`, an authenticated browser boundary for `app_documents` with abortable reads, typed revision-RPC writes, and an explicit HTTP 409/PT409 conflict error.
- Moved the public `readStorage`, `writeStorage`, and `removeStorage` facade from the PC KV API to that boundary without changing caller signatures.
- Changed `useStoredDocument` cache entries to `{ payload, revision }`; queued writes now use the revision acknowledged by the preceding RPC write. A failed initial read still blocks all writes.
- Added `app-documents:supabase`, defaulting to dry-run. Its importer validates every local `*.json` filename before constructing a remote client, rejects unknown keys with filename-only diagnostics, and inserts only missing rows with `--apply`.
- Updated the shared browser storage test fixture to emulate the Supabase document query/RPC surface.

## TDD evidence

- RED: `npm test -w web -- src/shared/storage/supabaseStorage.test.ts` failed because `supabaseStorage` did not exist.
- RED: `services/api/.venv/Scripts/python.exe -m pytest tests/test_app_documents_supabase_script.py -q` failed because `app-documents-supabase.py` did not exist.
- RED: the queued-revision hook test failed with received revisions `[1, 1]` where `[1, 2]` was required.
- GREEN: focused browser storage suite passed 20/20 tests; importer suite passed 3/3 tests.

## Verification

- `npm test -w web -- src/shared/storage` — passed (4 files, 20 tests).
- `services/api/.venv/Scripts/python.exe -m pytest tests/test_app_documents_supabase_script.py -q` — passed (3 tests; two existing Starlette/httpx deprecation warnings).
- `npm run typecheck` — passed.
- `npm run lint` — passed.
- `npm test` was run once. It exposed legacy tests whose bespoke fetch stubs only implement the retired `/api/kv/*` endpoints (notably projector-capital, PriceAlertsWatcher, and selected App tests). These are test-double migration failures, not focused storage-contract failures.
- `npm run api:test` was started once and collected 839 API tests; the execution did not reach a completion summary within the available command window.

## Self-review

- The importer validates unknown filenames before any credentials are read or HTTP client is created, so known files sorting before an unknown file cannot be partially imported.
- Manifest/error output contains key/filename and byte count only; it does not include payloads, URLs, or secrets.
- No `.local-data/kv` source file is written or deleted, and the browser module imports only the publishable Supabase client.

## Concern

The full web suite needs its remaining bespoke PC-KV fetch stubs migrated to Supabase document/RPC fixtures. This task updated the reusable fixture and its directly scoped tests; the legacy failures are documented above rather than masked.
