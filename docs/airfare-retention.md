# Airfare departure retention rollout

Status: code prepared, **not applied to the production Pi or Neon branch**.
The production replica is Neon project `little-glitter-67762070`, branch
`br-young-voice-bb6rhbca`. The Pi uses `DATABASE_URL` for collector writes.
The two retention migrations and their pgTAP tests passed on an expiring Neon
branch cloned from production on 2026-11-12. Full source equivalence and a
representative chart rehearsal also passed there; production pruning remains
pending.

## What expires

At 00:00 UTC on D+2, a flight departing on D is below the exclusive cutoff.
The Pi and replica retain all observations of later departures, including those
captured weeks earlier. One immutable route/departure partition retains price
frequencies, provider prices, unsold counts, health and departure minimum.
`How the price moved` and its exact median remain. `Flights seen` has no offers
for departed flights. Owner watch preferences remain selected. Calendar health
checks are route level and are not removed by this policy.

The confirmed Neon Free project has a **1 GB logical storage limit**; this is a
capacity limit, not a monthly allotment of new rows. On 2026-11-12 its root
branch reported **494,977,024 bytes** against **1,073,741,824 bytes** allowed,
and `neondb` reported **472,260,608 bytes**. The Free plan does not expose the
v2 monthly consumption endpoint, so monthly GB-month usage cannot be read from
that API. Paid storage can be metered as GB-month. Sources:
[Neon free-plan update](https://neon.com/blog/neon-free-plan-1-gb-per-project),
[Neon storage metering](https://neon.com/blog/new-usage-based-pricing).

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

On the Pi, `/var/lib/edicius-hq/fares` measured **431 MB** and
`/var/lib/edicius-hq/fx` measured **2.5 MB** on 2026-11-12.
`/var/lib/edicius-hq` measured **2.5 GB** after removing the confirmed 890 MB
migration profile. Re-measure rather than treating these as live figures:

```sh
sudo du -sh /var/lib/edicius-hq/fares /var/lib/edicius-hq
sudo du -h -d 1 /var/lib/edicius-hq
```

`reconciliation-*`, `fares-before-reconciliation-*` and `fares-drift` can hold
copies outside the active `/fares` tree. Inventory exact paths and departure
dates. Completion cannot be claimed while expired offer detail remains there.
This runner does not remove those copies automatically.

On 2026-11-12, read-only Neon counts below the D+2 cutoff were 17,016 of
108,183 snapshots, 15,447 of 169,752 baseline rows, and 28,268 of 155,706
board checks. Their containing tables measured 180,879,360, 87,785,472, and
88,170,496 bytes including indexes. These counts do not predict exact reclaimed
bytes; relation pages and indexes can remain allocated after deletion.

The first source preflight found seven lines with **leading NUL padding** in five
Pi journals: `checks/AQP-LIM.jsonl`, `checks/LIM-AQP.jsonl`, and the spend files
for 2026-09-03, 2026-10-05 and 2026-10-11. The bytes after each prefix decode
as valid JSON. Four affected board checks were absent from Neon. The live Pi
file was checked separately, so this is not a transfer artifact. No production
journal has been repaired yet. The isolated rehearsal uses repaired copies and
four board checks inserted into its temporary Neon branch. A production run
must first stop Airfare writers, back up the five originals outside `fares`, run
`scripts/fares-repair-null-bytes.py --apply` as `edicius-collector`, replay the
full sync, and require a zero-mismatch dry run. Keep the backups until final
verification, then review them against the expired-detail policy.

The isolated rehearsal reached zero preflight mismatches, then removed 17,016
snapshots, 15,447 baseline rows and 28,271 board checks below the 2026-11-11
cutoff from its copied source and Neon branch. It retained 302 exact departure
summaries and finished with zero source/replica mismatches. Comparing the
original Pi archive with the retained branch yielded **zero numerical day
differences** in low, high, median and count for price and provider series in
October (expired), November (mixed) and December (future). Raw `jsonb::text`
hashes changed because numeric spellings such as trailing zeroes changed;
numeric values did not. A second apply returned the same run ID, zero expired
rows and no mismatches; the branch still had one run and 302 summaries. This
does not verify the live Pi or production Neon after deployment.
For `AQP-LIM`, the expired October month retained 24 price days and zero flight
offers; mixed November retained 67 price days and 699 flight projections, and
future December retained 77 price days and 975 flight projections.

Physical space did not fall just from `DELETE`: the branch database grew to
522,690,560 bytes after replay, versus 472,768,512 bytes measured on production
at the same time. On the isolated branch, sequential `VACUUM (FULL, ANALYZE)`
of `fare_snapshots`, `fare_baseline_points` and `fare_checks` reduced it to
396,476,416 bytes. That is a measured rehearsal, not a production saving or a
guarantee for future data. Run the physical rewrite only in a separate window
with sufficient headroom and verify manifests again afterward.

## Disposable equivalence rehearsal

1. Use an isolated Neon branch and a copied Pi source tree. Apply
   `neon/migrations/20261112_airfare_departed_retention.sql` and
   `neon/migrations/20261112_airfare_retention_indexes.sql` there. Both
   migrations and their pgTAP tests passed on the expiring
   `retention-review-20261112` branch. Full source comparison and numerical
   checks for three representative months also passed there.
2. Capture pre-retention month projections for an expired month, a mixed month,
   and a future-only month, plus full source and destination manifests and
   all remaining record IDs. Run `npm run fares:retention -- --dry-run` with the
   copied source and isolated replica credentials. A mismatch is a stop.
3. Run `npm run fares:retention -- --apply` on the copy. Compare every historical
   low, high, median, count, provider day, unsold count, health and pair reference
   exactly; compare every future payload and key set. Assert old offers and
   expired calendar points are absent in both copies. Repeat apply and replay
   `npm run fares:sync -- --apply --full` from byte zero; neither may
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

   Repair the five known journals while writers are stopped, using the
   collector account and a fresh backup directory outside `fares`. The repair
   script removes only leading NUL bytes from lines whose remaining JSON is
   valid; it validates every listed file before editing any of them. It refuses
   a second run with an existing backup target. Inspect its dry-run result
   first, then run `--apply --backup-dir ...` and verify that each file remains
   owned by `edicius-collector` with mode `600`. Replay the full Airfare sync
   before the retention dry run so the four recovered checks reach Neon.

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
