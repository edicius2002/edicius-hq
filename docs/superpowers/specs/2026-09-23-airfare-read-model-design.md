# Airfare month read model

## Goal

Make first visits and route/month switches render the selected month without downloading every historical snapshot and provider baseline point. Preserve the current meanings of the price chart, Flight details, departure chart, route detail and health indicators. Keep the local journals authoritative and Supabase as a read replica.

## Data contract

Build a versioned projection for each `(origin, destination, YYYY-MM)` from the existing replica. It contains daily cheapest-fare buckets across collection timestamps (low, high, median, count), unsold collection counts, daily provider baseline buckets, the latest full board for each departure date, current health, and the whole-pair reference. The live How the price moved chart uses daily buckets only. Airport names retain their separate owner RPC. Flight rows are a separate keyed projection for the later table reader. A flight's previous price is its last distinct earlier price; sightings count unique boards; presence compares against the last board for its own departure date. Latest period membership supports day, week and month.

## Publication

Rebuild only affected route/month projections after a successful importer run. Publish one route/month atomically with a monotonically increasing projection revision. Existing projections remain available if an importer run fails. A full backfill covers all existing months before any web reader switches. The old archive RPC remains for rollback and parity checks.

## Read and rollout

The first stage exposes owner-gated RPCs for one month overview and its flight rows. The later web stage must add server-side table filters, sorting, facets and pagination before using flight rows in the UI; the current all-rows RPC is only for parity checks. The selected month has priority. Other watched months are fetched after first paint or upon navigation. Compare every projection against the current client computations on representative real routes, including absent flights, stable repeated prices, empty boards, revised baseline points and multiple watched months. Deploy database and backfill first, then importer publication, then web reader. Measure route switch latency and request count in production before retiring the old path.
