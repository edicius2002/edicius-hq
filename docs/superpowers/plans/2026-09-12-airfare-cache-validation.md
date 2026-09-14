# Airfare History Cache Validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Independently prove the airfare history cache preserves the public API contract, invalidates on filesystem changes, recovers from read errors, and improves repeated-read performance on a stable copy of the real archive.

**Architecture:** Tests exercise `GET /api/fares/history` through FastAPI's `TestClient` with a `FareHistory` rooted in a temporary directory. Measurement scripts copy read-only source data into a temporary dataset, run explicitly labelled access phases, record content digests/read counts/timings/memory, and optionally replay saved responses in a GPU-disabled local browser without describing that replay as WAN latency.

**Tech Stack:** Python 3.12, pytest, FastAPI TestClient, Pydantic, `tracemalloc`, Playwright/Chromium, JSON/JSONL.

**Spec:** `docs/airfare-data-loading.md`

## Global Constraints

- Modify only airfare data-loading validation and measurement artifacts owned by Worker 2.
- Do not modify backend implementation, `test_fare_history_cache.py`, frontend code, or lockfiles.
- Preserve the API and all filter/order/content semantics.
- Use temporary files for every mutating test and measurement phase.
- Treat `D:/Work/research/edicius-hq/services/api/.local-data` as read-only and never start collectors or invoke real write endpoints.
- Preserve `docs/airfare-measurements.json`; write new baseline and optimized reports separately.
- Label first access as “first access in a new process,” not “cold disk.”
- Do not use fragile millisecond thresholds in tests.
- Integrate Worker 1 only after `git show edicius2002/airfare-cache:docs/airfare-cache-result.md` contains `Status: complete`, cherry-picking commits after `a4c479a900ab7a2eb45e33a94d72419caea2e4fd` in order.

---

### Task 1: Public Endpoint Integration Contract

**Files:**
- Create: `services/api/tests/fares/test_fare_history_cache_integration.py`

**Interfaces:**
- Consumes: `app.main.app`, `app.routers.fares.HISTORY`, and the public HTTP route `GET /api/fares/history`.
- Produces: black-box regression coverage for content equivalence, cache hit/miss behavior, invalidation, and recoverable errors.

- [ ] **Step 1: Write contract fixtures and exact response assertions**

Create literal JSONL rows for two ordered snapshots with multiple offers, literal baseline/check rows, and airport metadata. Assert exact `snapshots`, `offers`, `baseline`, `health`, and `airports` output for normalized route codes plus `departure`, `since`, and `until` filters.

- [ ] **Step 2: Add cache behavior tests**

Count reads of only the temporary route archive by wrapping `Path.open`, then assert:

```python
first = client.get(HISTORY_URL)
second = client.get(HISTORY_URL)
assert first.json() == second.json()
assert archive_read_count == 1
```

After an external append, replacement, or truncation made with the unwrapped file primitive, call the endpoint again and assert both the new literal content and one additional archive read.

- [ ] **Step 3: Add absence and error recovery tests**

Assert an initially absent route returns a genuine empty response, creation after that response is observed, an injected `OSError` returns a non-200 server error rather than a successful empty history, and a later request succeeds after the injected fault is removed.

- [ ] **Step 4: Verify the tests fail for cache-specific reasons on the base commit**

Run:

```powershell
& 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fare_history_cache_integration.py
```

Expected on `a4c479a`: unchanged repeated reads are misses and an `OSError` is incorrectly returned as HTTP 200 with empty snapshots. Content-only tests may already pass.

- [ ] **Step 5: Commit the independent integration tests**

```powershell
git add -- services/api/tests/fares/test_fare_history_cache_integration.py docs/superpowers/plans/2026-09-12-airfare-cache-validation.md
git commit -m "test(airfare): define history cache integration contract"
```

### Task 2: Reproducible Backend Measurement Harness

**Files:**
- Modify: `scripts/measure_airfare.py`
- Create: `docs/airfare-cache-baseline.json`

**Interfaces:**
- Consumes: a read-only `--data-dir`, route selection, and a fixed commit under test.
- Produces: a report with dataset digest/size, commit, process/access phase, archive reads, response digest/counts, timing samples, and peak traced memory.

- [ ] **Step 1: Write script tests in the integration test module**

Run the script as a subprocess against a tiny fixture dataset and assert it never changes source hashes; reports distinct `first_process_access`, `unchanged_repetitions`, `after_append`, and `after_replace_or_truncate` phases; and records equal response digests when content is unchanged plus changed counts/digests after controlled mutations.

- [ ] **Step 2: Run the script test and confirm it fails because the phases are absent**

Use the same pytest command as Task 1 and verify the expected missing-report-shape assertion.

- [ ] **Step 3: Implement the measurement modes**

Add CLI options for route/sample selection and output. Copy the selected archive plus its baseline/checks/airports/watchlist into a temporary dataset before measuring. Use a child process for the first-access phase, repeat in one process for unchanged accesses, mutate only the copy for append and replace/truncate phases, and capture `tracemalloc` peak bytes and stable response digests.

- [ ] **Step 4: Verify script tests pass on the harness implementation**

Run the targeted pytest command and confirm only cache-contract tests expected to require Worker 1 remain red.

- [ ] **Step 5: Measure the base commit on the largest route copy**

```powershell
& 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe' scripts/measure_airfare.py --data-dir 'D:/Work/research/edicius-hq/services/api/.local-data' --pair AQP-LIM --samples 15 --output docs/airfare-cache-baseline.json
```

Confirm the source dataset hashes are unchanged before and after the command.

- [ ] **Step 6: Commit harness and baseline report**

```powershell
git add -- scripts/measure_airfare.py docs/airfare-cache-baseline.json
git commit -m "perf(airfare): measure history cache access phases"
```

### Task 3: Browser Replay Metadata and Methodology Guardrails

**Files:**
- Modify: `scripts/measure_airfare_browser.py`
- Modify: `scripts/airfare-measurement/build.mjs`

**Interfaces:**
- Consumes: saved measurement payloads only.
- Produces: browser replay metrics explicitly labelled local, GPU-disabled, and excluding backend/auth/WAN.

- [ ] **Step 1: Add a subprocess/report test for browser metadata**

Assert the browser report identifies response replay, records the exact Chromium flags including `--disable-gpu` and `--disable-software-rasterizer`, and never labels a number as WAN or end-to-end latency.

- [ ] **Step 2: Confirm the metadata test fails on the existing report shape**

Run the targeted pytest command and verify the missing launch metadata is the failure.

- [ ] **Step 3: Implement explicit launch and interpretation metadata**

Keep loopback replay read-only, add the GPU-disable flags, record viewport/build/commit/payload digest, and describe timing boundaries in structured fields.

- [ ] **Step 4: Run the targeted tests and static checks**

```powershell
& 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fare_history_cache_integration.py
& 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe' -m ruff check scripts/measure_airfare.py scripts/measure_airfare_browser.py services/api/tests/fares/test_fare_history_cache_integration.py
```

- [ ] **Step 5: Commit browser measurement changes**

```powershell
git add -- scripts/measure_airfare_browser.py scripts/airfare-measurement/build.mjs services/api/tests/fares/test_fare_history_cache_integration.py
git commit -m "test(airfare): qualify local browser replay measurements"
```

### Task 4: Integrate Worker 1 and Validate Before/After

**Files:**
- Create: `docs/airfare-cache-optimized.json`
- Create: `docs/airfare-optimization-results.md`

**Interfaces:**
- Consumes: completed commits from `edicius2002/airfare-cache` after the common base, the Task 1 contract, and the Task 2 harness.
- Produces: independently verified integrity/performance results and a reproducible comparison.

- [ ] **Step 1: Confirm the completion marker and review commit scope**

Run:

```powershell
git show edicius2002/airfare-cache:docs/airfare-cache-result.md
git log --reverse --format='%H %s' a4c479a900ab7a2eb45e33a94d72419caea2e4fd..edicius2002/airfare-cache
git diff --stat a4c479a900ab7a2eb45e33a94d72419caea2e4fd..edicius2002/airfare-cache
```

Do not proceed until the marker contains `Status: complete` and the commits stay within Worker 1's scope.

- [ ] **Step 2: Cherry-pick Worker 1 commits in chronological order**

Cherry-pick each hash listed by the reverse log. Do not modify the parent checkout or push.

- [ ] **Step 3: Run integration and relevant API regression tests**

```powershell
& 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fare_history_cache_integration.py services/api/tests/fares/test_fare_history_store.py services/api/tests/fares/test_fares_endpoint.py
```

Require every cache hit/miss, content, invalidation, and recovery assertion to pass without millisecond thresholds.

- [ ] **Step 4: Measure the optimized commit on the same frozen dataset copy**

Run the harness with the same selected source, pair, and samples as Task 2, saving `docs/airfare-cache-optimized.json`. Record the exact baseline and optimized commit hashes.

- [ ] **Step 5: Write the results report**

Document methodology, commit hashes, dataset digest, exact content-equivalence evidence, phase-by-phase timings/read counts/memory, limitations, browser replay caveat, and any concrete outstanding defect reproductions. Preserve `docs/airfare-measurements.json` unchanged.

- [ ] **Step 6: Run final verification and commit**

```powershell
git diff --check
& 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe' -m pytest -q -p no:cacheprovider services/api/tests/fares/test_fare_history_cache_integration.py services/api/tests/fares/test_fare_history_store.py services/api/tests/fares/test_fares_endpoint.py
& 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe' -m ruff check scripts/measure_airfare.py scripts/measure_airfare_browser.py services/api/tests/fares/test_fare_history_cache_integration.py
git status --short --branch
git add -- docs/airfare-cache-optimized.json docs/airfare-optimization-results.md
git commit -m "docs(airfare): report cache integrity and performance"
```
