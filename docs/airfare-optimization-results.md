# Airfare history cache validation

Results from September 15, 2026, limited to data loading for **How the price
moved** and **Flights seen**.

Tracking issue: [#198](https://github.com/edicius2002/edicius-hq/issues/198).

## Result

The cache preserves the complete public contract and avoids rereading and
decoding an unchanged archive. For AQP-LIM, using the same frozen dataset and
15 unchanged repetitions, median **direct endpoint model-construction time**
fell from **1,890.39 ms** to **1,003.37 ms**: 887.02 ms less, or **46.92%**.
JSONL reads across those 15 repetitions fell from **15 to 0**.

That timing ends immediately after the production `get_history` function
returns. It includes the history read or cache lookup and construction of the
Pydantic response model. It excludes `model_dump_json`, the HTTP stack,
authentication, transport compression, browser work, and network latency. The
46.92% result must therefore not be described as serialized endpoint, HTTP,
browser, or WAN latency.

The frontend, API shape, filter semantics, route/month storage layout, and
calendar path were not changed. No collector or real write endpoint ran.

## Versions and common data

- Common backend base: `86eea67363d1b40023db40cbf48b6ac652737add`.
- Baseline measurement commit: `fabcdc6ffd8902f178957c8d74bba533f4b20bac`.
  That commit adds only independent tests; the measured backend is still
  `86eea67`.
- Integrated and measured implementation:
  `9c13b384fc316efffd398371689d4d45f56239a4`.
- Frozen dataset manifest SHA-256:
  `334409015eb34be119de608f60c053110c89cedd5d516b1f61367af2653bb5ef`.
- The frozen AQP-LIM archive is 25,214,123 source bytes with 5,189 snapshots
  and 105,152 offers. Its prepared response is 23,216,605 bytes uncompressed
  and 1,060,625 bytes under gzip.

The complete selected copy—history, baseline, checks, airports, calendar, and
watchlist—is 27,061,580 bytes. The harness verified that the real read-only
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

| Phase                         |           Baseline |          Optimized | Baseline -> optimized JSONL reads | Interpretation                                                  |
| ----------------------------- | -----------------: | -----------------: | --------------------------------: | --------------------------------------------------------------- |
| First access in a new process |        1,576.14 ms |        2,561.61 ms |                            1 -> 1 | One sample per version; not evidence of a general improvement.  |
| 15 unchanged repetitions      | 1,890.39 ms median | 1,003.37 ms median |                           15 -> 0 | Primary comparison: -46.92%.                                    |
| After append                  |        1,668.61 ms |        1,598.71 ms |                            1 -> 1 | One sample; proves invalidation and reread, not a timing trend. |
| After replacement             |        1,484.94 ms |        1,626.48 ms |                            1 -> 1 | One sample; proves invalidation and restored content.           |
| After truncation              |           54.91 ms |           71.45 ms |                            1 -> 1 | One sample of an archive reduced to one snapshot.               |

The p95 over the 15 unchanged repetitions was 2,053.63 ms at baseline and
1,370.53 ms with the cache. Tests contain no brittle millisecond thresholds;
timing stays in measurement artifacts while tests prove reads, invalidation,
error semantics, and content.

The memory probe is a separate extra access after each timed phase because
`tracemalloc` materially distorts this roughly 20 MB decode. On the unchanged
phase, traced incremental peak allocation fell from 184,456,887 to 137,374,962
bytes (47,081,925 bytes, 25.52%). The baseline probe rereads the archive and the
optimized probe hits the cache. This is not RSS, excludes memory retained by
the cache before tracing starts, and is not total process memory.

## Integrity, invalidation, and endpoint regressions

All five compared states—first access, unchanged repetition, append,
replacement, and truncation—have identical response SHA-256 values between
baseline and optimization. In the unchanged state both report exactly:

- 5,189 snapshots;
- 105,152 offers;
- 1,846 baseline points;
- two airports; and
- health with 3,269 checks, 2,669 changes, 21 errors, and the same
  `lastCheckedAt`.

After append the response contains 5,190 snapshots and 105,173 offers. After
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

The semantic correction is commit `9a087a7`; independent validation preparation
is commit `fb473a8`. Both are reachable from the published branch after its
rebase onto `origin/main`.

## Final integrated verification

The repository virtual environment was synchronized with the pinned
`services/api/requirements.txt` before verification. The complete API
collection passed **640 tests**. The web collection passed **2,266 tests** with
two skipped tests. API Ruff formatting and lint, API mypy, web formatting,
lint, type checking, and the production web build also passed.

The earlier `fastapi.routing.iter_route_contexts` collection error occurred
only with the stale local FastAPI 0.116.1 installation and did not recur with
the pinned FastAPI 0.141.1 dependencies. It was an environment-version problem,
not a repository failure.

## Rerunning the methodology

Both checkouts must use the same `--frozen-copy`. The first run creates it and
the second detects and reuses it unchanged. Each `--work-dir` must be new. The
baseline backend predates the harness, so the commands restore only the harness
from `17dd248` into that detached worktree; the report still records the
baseline backend commit. Because `.local-data` is a live collector output, a
later run creates a new frozen dataset and may produce different counts and
timings; its own report hashes are the evidence that both checkouts used the
same capture. The temporary frozen bytes used for the published numbers were
removed after verification and are not distributed with the repository, so
these commands rerun the method rather than reproduce the historical digests.

```powershell
$python = 'D:/Work/research/edicius-hq/services/api/.venv/Scripts/python.exe'
$source = 'D:/Work/research/edicius-hq/services/api/.local-data'
$runRoot = Join-Path $env:TEMP ('edicius-airfare-cache-validation-' + [guid]::NewGuid())
$baseline = Join-Path $runRoot 'baseline'
$optimized = Join-Path $runRoot 'optimized'
$frozen = Join-Path $runRoot 'frozen'

New-Item -ItemType Directory -Path $runRoot | Out-Null
git worktree add --detach $baseline fabcdc6
git worktree add --detach $optimized 9c13b38
git -C $baseline restore --source 17dd248 -- scripts/measure_airfare.py

# Baseline backend with the later measurement harness:
Push-Location $baseline
& $python scripts/measure_airfare.py --data-dir $source --frozen-copy $frozen `
  --work-dir (Join-Path $runRoot 'baseline-work') --pair AQP-LIM --samples 15 `
  --output docs/airfare-cache-baseline.json
Pop-Location

# Integrated cache implementation:
Push-Location $optimized
& $python scripts/measure_airfare.py --data-dir $source --frozen-copy $frozen `
  --work-dir (Join-Path $runRoot 'optimized-work') --pair AQP-LIM --samples 15 `
  --output docs/airfare-cache-optimized.json
Pop-Location

& $python "$optimized/scripts/measure_airfare.py" --compare `
  "$baseline/docs/airfare-cache-baseline.json" `
  "$optimized/docs/airfare-cache-optimized.json" `
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
  constructs response models and defensive copies for 105,152 offers. Splitting
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
