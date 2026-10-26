# SEACE exclusion response: measurements and findings

Date: 25 October 2026, America/Lima. Production app: `https://edicius-hq-web.vercel.app`. The browser was signed in as the owner and used Arequipa, Minor, All objects, default Published descending, 50 rows per page. These are click-to-visible-DOM timings collected through Chrome browser automation, not isolated server, JavaScript, paint, or frame timings. Automation overhead and system load are included.

| Production action                                       |                   Observation |
| ------------------------------------------------------- | ----------------------------: |
| Navigate to Closed, initial page                        |                      2,007 ms |
| Navigate to Published, initial page                     |                      1,554 ms |
| Navigate to Open, after visiting it earlier             |                      1,105 ms |
| Switch Closed between included/excluded, eight attempts | 701–2,074 ms; median 1,079 ms |
| Repeat warm Closed switch, six attempts                 |   425–1,014 ms; median 522 ms |
| Switch empty 24h table, six attempts                    | 448–1,163 ms; median 1,012 ms |
| Exclude one Closed record until the included count fell |                        735 ms |

Closed began with 6,622 included and 668 excluded records. The one-record test changed these to 6,621 and 669. Two restore attempts through the production UI returned no visible error but left the row excluded, even after a full page reload. The test exclusion was then removed in the Supabase Table Editor by its exact record key, `minor:["Arequipa","CM-9084-2026-UZARE"]`. A fresh app load confirmed the original 6,622/668 counts and that the test row was absent from Excluded.

The empty-table switch varied as much as the 50-row switch. The browser samples therefore do not support a claim that 50-row React rendering is the dominant delay. A network waterfall was unavailable, so no transport or paint percentage is assigned.

## Database timings

The production SQL Editor ran `EXPLAIN (ANALYZE, BUFFERS)` on `public.read_owner_seace_page` with the same authenticated owner and page/filter arguments used by the app. One owner exists in this project; the SQL session set its JWT subject before each RPC. These are individual executions on a shared nano instance, so cache and concurrent load can change the result.

| RPC, Arequipa/Minor/page 1 | First observed | Repeated after warming table pages |
| -------------------------- | -------------: | ---------------------------------: |
| Closed / Not excluded      |       1,429 ms |                             134 ms |
| Closed / Excluded          |       1,646 ms |                             122 ms |
| Published / Not excluded   |         291 ms |                       Not measured |
| Open / Not excluded        |         230 ms |                       Not measured |
| 24h / Not excluded         |           7 ms |                       Not measured |

A simpler `count(*)` over the Closed membership, before evaluating exclusions or sorting, read 382 shared buffers from storage and took 1,836 ms in a sequential scan. The immediate repeat hit all 2,215 buffers in memory and took 8 ms. This supports cold database I/O as a major source of the slow Closed reads. It does not prove that a new index or a larger instance is the best remedy: the current RPC also computes exclusion keys and exact totals, and an index-only alternative has not been benchmarked on the live data. A schema change should be tested against that query plan before deployment.

## Reproducible local signals

- The production restore symptom is explained by the pinned postgrest-js `.in()` builder wrapping comma-containing keys in double quotes without escaping their embedded JSON quotes. [PostgREST's URL grammar](https://docs.postgrest.org/en/v16/references/api/url_grammar.html) requires escaping embedded quotes and backslashes in `in` list literals. Live PostgREST reads against the exact saved key returned one row for raw `eq`, zero for quoted `eq`, and one for an escaped `in` literal. The corrected implementation therefore uses raw `.eq()` for one key and an escaped `in` list for two or more keys.
- Before the page change, a test holding the exclusion write unresolved kept the selected row on screen. After the change, the row disappears while the write is still unresolved. A rejected write restores the row and its selection when the same page is active; switching to Excluded before the failure leaves its empty selection intact.
- Marking the cached variants stale and then excluding a row caused three extra page loads while the write was pending (seven calls versus four). After guarding prefetch during the write, the same test observed no extra loads until the write completed. A second test held the active post-write reload open: before prioritization four requests started; afterward only the active reload starts until it finishes.
- Another test held an older active page read open during exclusion. When that read resolved, its stale row did not overwrite the optimistic removal.

## Paired real-browser comparison

The unmodified `HEAD` and the changed frontend ran in separate local Vite processes. Headless Chrome opened each on the same machine, with separate authenticated browser origins connected to the **same production Supabase project**. For each of five paired trials, the browser loaded Arequipa / Minor / Closed, selected the same included record (`CM-9084-2026-UZARE`), and clicked **Exclude selected**. A capture-phase click listener and `MutationObserver` measured the interval until its table row left the DOM; the next animation frame was within 1–4 ms of that mutation. Trials alternated which frontend ran first. After every exclusion, the changed frontend restored the record and an administrative read confirmed zero matching exclusions before the next trial. These are real browser and database operations; only the frontend origin was local.

| Paired trial | Unmodified, click to row removal | Changed, click to row removal |
| ------------ | -------------------------------: | ----------------------------: |
| 1            |                         604.5 ms |                      117.6 ms |
| 2            |                       1,078.4 ms |                      104.3 ms |
| 3            |                       1,020.5 ms |                      120.4 ms |
| 4            |                         776.1 ms |                      136.2 ms |
| 5            |                       1,353.6 ms |                      143.8 ms |
| **Median**   |                   **1,020.5 ms** |                  **120.4 ms** |

The observed median reduction is **88.2%** (about **8.5 times faster**) for the visible row change. The HTTP write itself was not faster: median write duration was 180.2 ms in the unmodified run and 607.6 ms in the changed run, with considerable network variation. In two changed trials, the row disappeared in 120–144 ms while the write took 608–796 ms. The optimization improves perceived response by showing the pending change immediately, while the server remains authoritative after refetch. Five pairs on one machine are not a production latency distribution, and a local Vite build does not establish the timing of the deployed URL.

Restoration was separately exercised through each frontend against the same real exclusion. The unmodified restore returned HTTP 204 but left one matching row in the database and kept it visible after one second. The changed restore returned HTTP 204, removed the row from the current view in 10.6 ms, and left zero matching database rows. A two-key test then excluded two visible records and invoked each version's batch restore through its actual data module: the unmodified call left both exclusions in place; the changed call removed both. Cleanup verified zero matching exclusions for each test key.

Pre-merge review found that one `in` URL for a full 100-row selection could exceed intermediary limits. The final client splits restores at 6,000 characters of encoded `record_key` query text; a test with 100 long process keys checks every generated request. If a later chunk fails, the page clears selection and refetches authoritative rows instead of rolling back the entire batch. The pager keeps the previous server total until that refetch and shows `0 shown of N` when the last visible row leaves. These safeguards were added after the five-pair browser run; the measured single-row removal path is otherwise the same. A live 100-key restore was not run against production.

The database findings justify a separate prototype of a narrow indexed read path, measured against the current function on a representative dataset before any schema migration.

After the live equality probe and review fixes, final verification passed 2,706 web tests with two skipped; typecheck, production build, format check, and lint completed. Lint reported 13 existing warnings outside the changed SEACE files and no errors. No production application deployment or database migration was made.
