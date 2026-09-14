# Airfare history cache validation

Results from September 14, 2026, limited to data loading for **How the price
moved** and **Flights seen**.

## Result

The cache preserves the complete public contract and avoids rereading and
decoding an unchanged archive. For AQP-LIM, using the same frozen dataset and
15 unchanged repetitions, median **direct endpoint model-construction time**
fell from **1,920.24 ms** to **1,068.16 ms**: 852.08 ms less, or **44.37%**.
JSONL reads across those 15 repetitions fell from **15 to 0**.

That timing ends immediately after the production `get_history` function
returns. It includes the history read or cache lookup and construction of the
Pydantic response model. It excludes `model_dump_json`, the HTTP stack,
authentication, transport compression, browser work, and network latency. The
44.37% result must therefore not be described as serialized endpoint, HTTP,
browser, or WAN latency.

The frontend, API shape, filter semantics, route/month storage layout, and
calendar path were not changed. No collector or real write endpoint ran.

## Versions and common data

- Common backend base: `a4c479a900ab7a2eb45e33a94d72419caea2e4fd`.
- Baseline measurement commit: `ea118ce12c795616ea4532b6cd2b02db9477622b`.
  That commit adds only independent tests; the measured backend is still
  `a4c479a`.
- Worker 1's original implementation: `ca39f0c87b337e4842501549373c88684499f8e0`.
- Originally integrated and measured implementation:
  `c1f150a13bf66f54434d12be965f5e9c60f7de33`.
- Frozen dataset manifest SHA-256:
  `ec6f786fbc30419920f2062406411e35855cf28a8b96a4d62edcae3dd3e78317`.
- The frozen AQP-LIM archive is 23,785,150 source bytes with 4,909 snapshots
  and 99,203 offers. Its prepared response is 21,912,762 bytes uncompressed
  and 1,002,036 bytes under gzip.

The complete selected copy—history, baseline, checks, airports, calendar, and
watchlist—is 25,587,862 bytes. The harness verified that the real read-only
source did not change during either run. The optimized run reused the baseline
frozen copy; append, replace, and truncate operated only on separate temporary
working copies.

These data are newer than the preserved
[`airfare-measurements.json`](airfare-measurements.json), which records 4,368
snapshots and 87,695 offers. Its latency is not compared directly with the new
capture. The valid before/after comparison uses the common frozen hash above,
and the original measurement file remains unchanged.

## Cache decision and limits

The implemented seam is a process-local LRU of decoded route histories keyed by
a stable file signature. An unchanged route can reuse decoded snapshots; an
append, replacement, truncation, or explicit local append invalidates the
entry. Missing archives remain a legitimate empty history and are checked
again on the next request. Existing archives that cannot be read are failures,
not empty histories: the public endpoint returns retryable HTTP **503** with a
generic message and does not disclose filesystem details.

The configured eight-route and 128 MiB limits are eviction/admission budgets
measured from **source-file bytes**. They are not an RSS or actual-RAM ceiling.
Decoded Python models, strings, lists, cache bookkeeping, and defensive copies
can occupy materially more memory than the JSONL bytes. RSS and retained heap
must be measured separately before treating those constants as a process memory
budget.

## Measured performance

All values below use the direct endpoint model-construction boundary defined
above.

| Phase | Baseline | Optimized | Baseline -> optimized JSONL reads | Interpretation |
| --- | ---: | ---: | ---: | --- |
| First access in a new process | 1,745.63 ms | 1,597.24 ms | 1 -> 1 | One sample per version; not evidence of a general improvement. |
| 15 unchanged repetitions | 1,920.24 ms median | 1,068.16 ms median | 15 -> 0 | Primary comparison: -44.37%. |
| After append | 1,819.85 ms | 1,626.87 ms | 1 -> 1 | One sample; proves invalidation and reread, not a timing trend. |
| After replacement | 2,175.86 ms | 2,341.01 ms | 1 -> 1 | One sample; proves invalidation and restored content. |
| After truncation | 53.28 ms | 75.32 ms | 1 -> 1 | One sample of an archive reduced to one snapshot. |

The p95 over the 15 unchanged repetitions was 2,441.18 ms at baseline and
1,455.49 ms with the cache. Tests contain no brittle millisecond thresholds;
timing stays in measurement artifacts while tests prove reads, invalidation,
error semantics, and content.

The memory probe is a separate extra access after each timed phase because
`tracemalloc` materially distorts this roughly 20 MB decode. On the unchanged
phase, traced incremental peak allocation fell from 174,403,242 to 129,976,841
bytes (44,426,401 bytes, 25.47%). The baseline probe rereads the archive and the
optimized probe hits the cache. This is not RSS, excludes memory retained by
the cache before tracing starts, and is not total process memory.

## Integrity, invalidation, and endpoint regressions

All five compared states—first access, unchanged repetition, append,
replacement, and truncation—have identical response SHA-256 values between
baseline and optimization. In the unchanged state both report exactly:

- 4,909 snapshots;
- 99,203 offers;
- 1,846 baseline points;
- two airports; and
- health with 3,112 checks, 2,520 changes, 21 errors, and the same
  `lastCheckedAt`.

After append the response contains 4,910 snapshots and 99,224 offers. After
replacement it returns to the original digest and counts. After truncation it
contains one snapshot with 16 offers. Every file change causes one archive read
and the stable repetition causes none.

Independent tests call public `GET /api/fares/history` through `TestClient` and
do not name or import cache internals. They cover:

- snapshots and every offer/field in order;
- exact baseline, health, and airport content;
- route normalization and `departure`, `since`, and `until` filtering;
- a warm-cache regression where absent `until`, present-but-empty `until=`, and
  a later absent `until` all return the same existing history, preserving the
  endpoint's original truthiness semantics;
- unchanged hits and invalidation after an external append;
- file creation after a legitimate empty response;
- replacement and truncation without stale rows; and
- a temporary read error as a non-success response, never a successful empty
  history, followed by recovery on the next request.

Worker 1 completed the semantic correction as
`e143e871b515e201903bf9eb6abecd5dae6f0590`; it was reviewed and cherry-picked
as `05ad440`. Independent validation preparation is commit `74ec0f4`.

## Final integrated verification

An isolated worktree-local virtual environment was populated from the pinned
`services/api/requirements.txt`; the shared root environment was not modified.
On the integrated result:

- the four focused history/cache/store/endpoint files passed **55 tests** with
  two upstream FastAPI/Starlette deprecation warnings in 9.23 seconds;
- the complete API collection passed **632 tests**, with the same two warnings,
  in 55.33 seconds;
- Ruff format checked 107 files; Ruff lint passed after the integration-test
  imports were kept in repository order; and
- targeted mypy passed the history service, fare router, measurement harness,
  and endpoint integration test with no issues.

The earlier `fastapi.routing.iter_route_contexts` collection error did not
recur under the pinned dependencies, so it was an environment-version problem,
not a repository failure. No unrelated test failure remained in this final full
run. The isolated environment and pytest temporary directories are removed
before handoff.

## Reproduction

Both checkouts must use the same `--frozen-copy`. The first run creates it and
the second detects and reuses it unchanged. Each `--work-dir` must be new.

```powershell
$python = 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe'
$source = 'D:/Work/research/edicius-hq/services/api/.local-data'
$frozen = "$env:TEMP/edicius-airfare-cache-aqp-lim-frozen"

# Backend base a4c479a with the harness from d8e6b25:
& $python scripts/measure_airfare.py --data-dir $source --frozen-copy $frozen `
  --work-dir "$env:TEMP/airfare-base-work" --pair AQP-LIM --samples 15 `
  --output docs/airfare-cache-baseline.json

# Integrated cache implementation:
& $python scripts/measure_airfare.py --data-dir $source --frozen-copy $frozen `
  --work-dir "$env:TEMP/airfare-optimized-work" --pair AQP-LIM --samples 15 `
  --output docs/airfare-cache-optimized.json

& $python scripts/measure_airfare.py --compare `
  docs/airfare-cache-baseline.json docs/airfare-cache-optimized.json `
  --output docs/airfare-cache-comparison.json
```

Complete artifacts:

- [`airfare-cache-baseline.json`](airfare-cache-baseline.json)
- [`airfare-cache-optimized.json`](airfare-cache-optimized.json)
- [`airfare-cache-comparison.json`](airfare-cache-comparison.json)

## Method limitations

- “First access” means first access in a new process. The operating system disk
  cache was not cleared, so this is not called a cold-disk measurement.
- Timed samples stop before `model_dump_json`; JSON serialization is performed
  afterwards only to hash and compare complete response content. HTTP,
  authentication, transport compression, network, browser work, and server
  concurrency are not measured. Gzip sizes are also computed outside the timer.
- The primary timing comparison uses 15 repetitions of one large route. First
  access and mutation phases contain one sample and validate content and
  invalidation rather than a distribution.
- No real collector race was exercised. Integrated internal tests cover
  controlled concurrent changes, and all mutation tests use temporary files.
- The browser replay was not rerun in this worktree because it has no
  `node_modules`. The tool records hashes, configuration, and both GPU flags
  (`--disable-gpu`, `--disable-software-rasterizer`) and labels the result as a
  local prepared-response replay. It is not WAN or end-to-end latency.

## Remaining work

- A cache hit still takes about one second for this archive because the endpoint
  constructs response models and defensive copies for 99,203 offers. Splitting
  history by route/month might reduce that work and transfer size, but it is
  explicitly outside this stage.
- Measure the complete HTTP server under realistic authentication, concurrency,
  and network conditions.
- Measure RSS and retained process memory in addition to incremental
  `tracemalloc` peaks.
- Run a new browser replay after web dependencies are prepared, and interpret it
  only as local transfer, decompression, JavaScript, and rendering cost.

No reproducible integrity or recovery defect remains within this validation's
scope after the completed corrective integration.
