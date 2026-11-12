# Airfare departure retention rollout

Status: code prepared, **not applied to the Pi or a hosted database**. The
application currently points Airfare and FX at `SUPABASE_URL` through Supabase
PostgREST. The request names Neon. Identify the actual production replica before
running a hosted migration or `--apply`; a distinct Neon Postgres database
requires a transport and auth integration that this Supabase RPC implementation
does not provide.

## What expires

At 00:00 UTC on D+2, a flight departing on D is below the exclusive cutoff.
The Pi and replica retain all observations of later departures, including those
captured weeks earlier. One immutable route/departure partition retains price
frequencies, provider prices, unsold counts, health and departure minimum.
`How the price moved` and its exact median remain. `Flights seen` has no offers
for departed flights. Owner watch preferences remain selected. Calendar health
checks are route level and are not removed by this policy.

The free Neon plan currently lists **1 GB per project** of Postgres storage;
this is a capacity limit, not a monthly allotment of new rows. Paid storage can
be metered as GB-month. The current Supabase Free plan lists **500 MB database
size**, a separate provider limit. Check the actual project plan and usage page
before comparing against either number. Sources:
[Neon free-plan update](https://neon.com/blog/neon-free-plan-1-gb-per-project),
[Neon storage metering](https://neon.com/blog/new-usage-based-pricing),
[Supabase pricing](https://supabase.com/pricing).

## Read-only inventory

Record the target project/branch identifier, URL hostname, plan and provider
storage metric. Keep credentials and raw expired rows out of reports. Capture
these SQL results on the identified replica before and after maintenance:

```sql
select pg_database_size(current_database()) as database_bytes;
select relname, pg_total_relation_size(oid) as total_bytes,
       pg_relation_size(oid) as heap_bytes,
       pg_indexes_size(oid) as index_bytes
from pg_class
where relnamespace = 'public'::regnamespace
  and relname in ('fare_snapshots','fare_baseline_points','fare_calendar_captures',
                  'fare_checks','fare_departure_summaries','fare_month_projections',
                  'fare_flight_projections')
order by total_bytes desc;
select phase, cutoff, target_cutoff, run_id from public.airfare_retention_state;
select item->>'dataset' as dataset, sum((item->>'count')::bigint) as records
from jsonb_array_elements(public.airfare_dataset_manifest()) item
where item->>'dataset' <> 'retention' group by 1 order by 1;
```

On the Pi, `/var/lib/edicius-hq/fares` was last reported as **430 MB** on
2026-11-12. `/var/lib/edicius-hq` was **2.5 GB** after removing the confirmed
890 MB migration profile. Re-measure rather than treating these as live figures:

```sh
sudo du -sh /var/lib/edicius-hq/fares /var/lib/edicius-hq
sudo du -h -d 1 /var/lib/edicius-hq
```

`reconciliation-*`, `fares-before-reconciliation-*` and `fares-drift` can hold
copies outside the active `/fares` tree. Inventory exact paths and departure
dates. Completion cannot be claimed while expired offer detail remains there.
This runner does not remove those copies automatically.

## Disposable equivalence rehearsal

1. Create an isolated database branch with the **identified provider** and a
   copied Pi source tree. Apply the additive summary/retention migration and
   index migration there. The current implementation has been exercised against
   a disposable local Supabase database; it has not been exercised against a
   hosted Neon branch.
2. Capture pre-retention month projections for an expired month, a mixed month,
   and a future-only month, plus full source and destination manifests and
   all remaining record IDs. Run `npm run fares:retention -- --dry-run` with the
   copied source and isolated replica credentials. A mismatch is a stop.
3. Run `npm run fares:retention -- --apply` on the copy. Compare every historical
   low, high, median, count, provider day, unsold count, health and pair reference
   exactly; compare every future payload and key set. Assert old offers and
   expired calendar points are absent in both copies. Repeat apply and replay
   `npm run fares:supabase -- --apply --full` from byte zero; neither may
   resurrect expired detail.
4. Inject an outage after summary publication, local replacement, remote prune
   and remote finish. Resume the same run ID and verify full equality. Confirm
   an old writer is rejected below the cutoff.

The local test used 20,000 synthetic checks (400 matching calendar rows). The
partial calendar index occupied 40,960 bytes versus 827,392 bytes for the old
full index. The tested health aggregate took 0.997 ms versus 0.756 ms in one
`EXPLAIN (ANALYZE, BUFFERS)` execution; the planner used the existing board
health index for the partial-index case. This is a small synthetic result, not
a production latency or storage claim. Repeat plans on representative staging
rows before releasing the index migration.

## First supervised production window

1. Deploy a compatible app and schema together. The ingress trigger, summary
   readers and local maintenance gate must be live before any pruning. Verify
   the actual replica host and service credentials. Do not enable the new timer.
2. Record which Pi Airfare units were active. Stop the collector timer/service,
   manual worker and sync timer/service for the window. Keep them stopped after
   any failed run:

   ```sh
   sudo systemctl stop edicius-airfare.timer edicius-airfare.service \
     edicius-airfare-requests.service edicius-airfare-sync.timer \
     edicius-airfare-sync.service
   ```

3. Run the CLI's read-only `--dry-run` in the collector service environment,
   pointing at the verified replica. Record cutoff, counts, estimated source
   bytes and preflight mismatches. A service-manager invocation with
   `EnvironmentFile=/etc/edicius-hq/collectors.env` is required; ordinary
   `sudo -u` alone does not load that file. The one-shot service always uses
   `--apply`, so do not use it for the dry run:

   ```sh
   sudo systemd-run --unit=edicius-airfare-retention-preview --wait --collect --pipe \
     -p User=edicius-collector -p Group=edicius-collector \
     -p WorkingDirectory=/opt/edicius-hq/current \
     -p EnvironmentFile=/etc/edicius-hq/collectors.env \
     --setenv=HOME=/var/lib/edicius-hq \
     --setenv=LOCAL_DATA_DIR=/var/lib/edicius-hq \
     /opt/edicius-hq/current/services/api/.venv/bin/python \
     /opt/edicius-hq/current/scripts/fares-retention.py --dry-run
   ```

4. After the dry run and staging comparison agree, start the one-shot service:

   ```sh
   sudo systemctl start edicius-airfare-retention.service
   sudo journalctl -u edicius-airfare-retention.service -n 100 --no-pager
   ```

   Exit zero is allowed only for a verified run. On failure, the durable pending
   state blocks ordinary writers. Re-run the same service to resume; do not
   reset the state file or restore old detail.

5. Compare the final full manifests and projection fields, remeasure table and
   provider usage, then restore only the Pi units that were active before the
   window. Enable `edicius-airfare-retention.timer` only after this first run
   verifies. The timer is installed disabled and fires daily at 04:17 UTC.
6. Review the exact reconciliation and drift paths. Scrub expired portions or
   delete wholly expired copies only after their operational source was checked.
   Preserve aggregate evidence and document each path removed.

Ordinary `DELETE`/`VACUUM` can leave allocated relation pages in place. If
provider usage does not fall as expected, measure heap/index sizes again and
plan a targeted `VACUUM FULL` or `REINDEX` in a separate exclusive-lock window
with enough temporary capacity. Recheck manifests and projections afterward.
Do not claim reclaimed capacity solely from deleted row counts. Review usage at
80% and act at 90% of the **confirmed project's** included capacity; this is a
manual threshold, not an automatic alert. Future-flight growth can still exceed
the limit.

Rollback disables maintenance and uses a retention-compatible writer and
reader release. It never lowers the cutoff or restores pruned detail from old
copies. Resume a pending run instead of regenerating a summary from already
compacted source files.
