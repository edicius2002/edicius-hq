# SEACE exclusion response design

The owner needs excluding and restoring records to feel immediate and to remain correct when moving between the included and excluded tables. The current page waits for the write and then invalidates every SEACE page query before clearing its busy state. Restoring a real record in production did not remove its exclusion, even after a reload.

## Evidence and goal

On 25 October 2026, Arequipa/Minor/Closed contained 6,622 included records before a one-record test exclusion. The exclusion appeared in the excluded table after about 0.7 seconds. Two restore attempts reported no error but left the record excluded. Warm included/excluded switches ranged from roughly 0.4 to 2.1 seconds in browser automation; an empty table showed similar variation, so that range does not isolate React rendering. Other cold view loads were about 1.6 seconds for Published and 2.0 seconds for Closed.

Make the selected row leave the current table in the same React update as the click. On a failed write with no completed restore chunk, restore the row and selection when the user is still on that page, and show an error. On a partial batch failure, refetch the server's actual state and show an error. After a successful write, reconcile cached pages with the server without blocking the controls. Restore must use PostgREST filters that match JSON-shaped exclusion keys for single and batch requests. Existing views, sorting, exact server totals, pagination, and owner scoping stay authoritative.

## Approach

Use raw `.eq()` for one key and correctly escaped `in` lists for batch deletion, split by encoded URL length when needed. A live read against the matching production row returned one result for raw equality and zero for quoted equality. PostgREST documents backslash escaping for literal double quotes and backslashes inside list values; the pinned postgrest-js `.in()` implementation wraps values containing commas but does not escape their embedded quotes. A database RPC would also solve the filter problem but would require a production migration for a client-side encoding issue. Per-key `.eq()` requests would make large restores scale with the selected count.

For the visible table, patch its TanStack Query cache optimistically, then write and refetch in the background. A failed write restores the snapshot if no earlier restore chunk succeeded; a partial failure keeps the optimistic view until a server refetch reconciles the rows and clears selection. Keep the previous server total while the write is pending so the pager does not jump pages; display an empty-page label instead of an impossible range. The opposite table is refreshed after the active read completes; cached server data continues to determine final ordering and totals. A full page requery may fill a temporary gap after removing a row. Production profiling found that a cold Closed query can take over a second while a warm repeat takes about 0.1 seconds. A database index redesign needs its own benchmark, so this change stays in the browser read/write path.

## Verification

- Data-layer tests check raw equality for one JSON-shaped key, escaped list literals, bounded encoded URLs, and partial failure for batch deletion. Live browser and database checks verify the small-batch paths.
- Page tests pause the write and verify that the selected row disappears before it resolves, then check rollback, partial-failure reconciliation, stable pagination, and selection after switching views on failure.
- Existing SEACE tests, typecheck, lint, and build must pass. Compare the baseline and changed frontend in a real browser against the same production database before deployment; production URL timing remains a separate follow-up.
