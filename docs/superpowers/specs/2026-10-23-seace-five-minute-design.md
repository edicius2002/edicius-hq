# SEACE five-minute notice refresh design

## Intent

Show new and changed Arequipa minor-contract notices promptly without repeating the full SEACE collection every five minutes. Keep the existing one-second spacing of prod6 HTTP starts and preserve the durable notice queue.

## Approaches

- Repeat the current three-source pass every five minutes: simple, but multiplies requests to processes and published contracts by twelve. Rejected.
- Add a separate five-minute notice pass while the hourly pass handles general processes and published contracts: chosen because the existing collector already separates these source kinds and serializes passes with `seace.lock`.
- Run parallel collectors for every source: could shorten latency, but adds concurrent source pressure and complicates checkpoints. Deferred.

## Behavior

- A new systemd timer runs minor-notice discovery every five minutes. It uses the existing incremental search and source-status reconciliation. It fetches detail and files only for newly enrolled or changed open notices and due pending retries; historical closed notices remain deferred.
- The existing hourly timer updates general processes and published contracts. A manual refresh still updates all three kinds.
- Each pass publishes and advances only the kinds it selected. Existing snapshots and exclusions for other kinds stay untouched.
- An open notice whose source row changes is re-enrolled for detail and files, while previously fetched fields remain available until replacement succeeds. A closure alone does not trigger new detail requests.
- A prod6 HTTP 403 opens a shared, durable 15-minute cooldown in `SEACE_STATE_DIR`. Already queued HTTP attempts are rejected locally; later five-minute notice passes skip upstream work until the deadline. A later 403 extends the cooldown. The existing queue retains incomplete IDs.
- The one-second prod6 start interval and five-in-flight ceiling remain unchanged.

## Constraints and risks

- The five-minute unit uses the existing nonblocking collector lock. An overlapping firing is skipped, and the next firing resumes from the queue and checkpoints.
- A sustained prod6 quota is not documented. Fifteen minutes is an operational backoff based on observed recovery, not an official rule.
- The historical backlog is not automatically activated. A large new-open batch can still take longer than five minutes; the queue must bound enrichment work per pass without losing IDs.
