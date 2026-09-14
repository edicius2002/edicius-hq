# Airfare read-cache result

Status: complete

## Approach

`FareHistory.read` keeps an LRU of decoded snapshots by route. An entry is
reused only while the file identity (`st_dev` and `st_ino`), size, and
`mtime_ns` all match; there is no TTL. The cache holds at most eight routes and
128 MiB of source files, bounding both the number of retained object graphs and
their growth with the archive size.

Each read acquires a striped per-route lock. A miss checks the signature before
and after decoding and retries up to three times when the file changes. This
prevents duplicate in-process reconstructions and prevents a partial read of a
concurrent write from becoming visible or entering the cache. A local append
uses the same lock and invalidates the entry immediately after the successful
write is closed.

The cache retains the complete route and applies `since` and `until` to each
returned result. These optional bounds preserve the reader's original
truthiness semantics: `None` and the empty string both mean that the respective
bound is absent. Each result receives new offer lists, so callers cannot mutate
the retained value. Individual corrupt lines are skipped while valid rows are
preserved; a completely unreadable file keeps the historical empty result and
error log, but that result is not cached.

`PermissionError` and other `OSError` failures for an existing file propagate.
The `/api/fares/history` endpoint translates them to HTTP 503 without exposing
filesystem details. A missing file remains a legitimate empty result and is
checked again on the next read, allowing it to appear later.

This work did not change the frontend, file format, route/month storage layout,
or the API and semantics of snapshots, ordinary bounds, ordering, baseline, or
checks.

## Verified invariants

- A cache hit performs no second decode, and filtering happens after the hit.
- Empty and absent optional bounds are equivalent on cache hits; non-empty
  bounds continue to filter inclusively.
- Local and external appends, creation after absence, replacement, and
  truncation are discovered.
- Reads require stability before and after decoding; sustained changes raise an
  error after bounded retries.
- Transient read errors propagate and a later read recovers; the HTTP boundary
  returns 503.
- Concurrent readers build one cached value per route.
- LRU eviction enforces route-count and source-byte budgets.
- Returned offer lists cannot mutate cached snapshots.
- Partial corruption preserves valid rows, and total corruption is not cached.

## Review correction

The initial cache implementation compared optional bounds explicitly with
`None`. That changed established behavior for `until=""`: the empty string
became an upper bound smaller than every timestamp and hid all existing
history. `_copy_filtered` now uses the original truthiness checks for both
`since` and `until`. The regression test first populates the cache with an
absent `until`, then reads the cache with an empty `until`, verifies identical
snapshots, verifies an ordinary bounded window, and confirms that no additional
decode occurred.

## Commands and results

The initial implementation was verified in a temporary worktree-local virtual
environment populated from `services/api/requirements.txt`; the environment
and pytest directories were removed afterward.

- Initial full API suite, `python -m pytest -q --basetemp
  .pytest-airfare-cache-full-local`: **622 passed**, with two upstream
  FastAPI/Starlette deprecation warnings, in 69.91 seconds.
- Review correction red test, `python -m pytest -q --basetemp
  .pytest-airfare-review-red
  tests/fares/test_fare_history_cache.py::test_empty_until_matches_absent_until_on_a_cache_hit_and_bounds_still_filter`:
  **1 failed**, observing an empty list instead of all three snapshots.
- Review correction green suite, `python -m pytest -q --basetemp
  .pytest-airfare-review-final tests/fares/test_fare_history_cache.py
  tests/fares/test_fare_history_store.py`: **26 passed** in 0.97 seconds.
- `python -m ruff format --check app/services/fare_history.py
  tests/fares/test_fare_history_cache.py`: **2 files already formatted**.
- `python -m ruff check app/services/fare_history.py
  tests/fares/test_fare_history_cache.py`: **All checks passed**.
- `python -m mypy app/services/fare_history.py`: **Success: no issues found in
  1 source file**.
- The initial full `python -m mypy` run found one pre-existing, out-of-scope
  error at `scripts/measure_airfare_browser.py:29`, concerning a class-variable
  override of `SimpleHTTPRequestHandler`. The owned production file passes the
  targeted typecheck, and this worker did not edit the measurement script.

## Read-only timing observation

A read-only check against
`D:/Work/research/edicius-hq/services/api/.local-data/fares/AQP-LIM.jsonl`
observed 4,524 snapshots and 91,011 offers in the file at that time. In one new
`FareHistory` process instance, the first reader call took 3,837.02 ms and the
immediate cache-hit reader call took 31.68 ms, with identical counts.

These timings cover `FareHistory.read` only. They exclude endpoint assembly,
Pydantic conversion and serialization, authentication, compression, network,
and browser work. The first value is the first read by that process, not a
disk-cold measurement: the operating-system filesystem cache was not cleared.
No collector ran and no real archive data was written.
