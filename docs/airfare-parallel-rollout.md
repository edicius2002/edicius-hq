# Airfare parallel refresh rollout

The scheduled board pass and manual route worker use a 0.05-second minimum
between Google Flights request starts. Board acquisition has a limit of 16
requests in flight. The manual worker runs at most two city pairs at once and
keeps two months of the same pair sequential. Both routes share the request
slots and one budget per UTC day, including its fallback count if ledger writes
fail. A route starting after UTC midnight receives the new day's budget.

The 2026-10-23 isolated Pi probe exercised 2, 4, 8, and 16 board slots and
two city pairs together. All 112 provider responses were HTTP 200 and parsed;
the 20-date case reached 16 in flight, and the two-pair case reached 16 in
flight with a 0.051-second median start gap. Ten production queue requests
separately synchronized 279 successful departure checks. The 26 errors were
confined to September 18–30, beyond the provider's useful horizon at the time.
The isolated probe established provider acquisition behavior; it did not run
the new worker or SQL claim RPC against the production archive.

## Deployment order

1. Apply `supabase/migrations/20261023000000_airfare_distinct_route_claim.sql`
   before starting the new worker. The existing two-argument claim RPC remains
   available during rollout. Confirm the three-argument RPC is executable by
   `service_role` and unavailable to `authenticated`.
2. Push this branch so the exact commit is fetchable by the Pi. Use
   `ops/pi/deploy.ps1 -PiHost bodas -Commit <full-commit-sha>` from a local
   interactive terminal. The script prompts for `sudo` on the Pi. It stages an
   exact release, checks the units, switches the release link, and restarts the
   worker and timers.
3. Enqueue two different route-month requests. Confirm both enter `running`
   before either finishes, their global in-flight peak stays at or below 16,
   and each reaches `complete` only after its route sync. Also test queue order
   A(month 1), A(month 2), B: B should start alongside A1 while A2 remains queued.

The pacer is process-local. The Pi archive lock prevents a scheduled pass and
the manual worker from running together, but the exact 0.05-second spacing is
not guaranteed across the instant when one service releases that lock and the
other acquires it.
