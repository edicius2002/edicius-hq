# ADR 0002 — Airfare price history is an append-only archive

- **Status:** Accepted
- **Date:** 2026-08-17
- **Context:** Delivery step 6b — Airfare, slice AIR-01
- **Supersedes:** nothing

## Context

The data plane's table (implementation plan, "Data Plane") splits traffic in two: **A** is user state, which goes to the KV store and later to Postgres; **B** is market data, which goes to FastAPI with a cache in front of it. Decisions 5.4 and 5.8 forbid putting a time series in Postgres without an ADR, and decision 8.7 says volatile data lives in memory while historical series live on disk.

Airfare needs a third thing that neither half describes.

`BarCache` — the only on-disk store the repository has — writes one file per symbol and timeframe and **replaces its entire contents** on every write:

```python
temporary.write_text(json.dumps({"symbol": ..., "timeframe": ..., "bars": [...]}))
temporary.replace(path)
```

That is correct for candles. Yahoo is the authority on what AAPL did last Tuesday; our copy is a convenience, and refetching it costs a request. `read_stale` exists precisely because the file is disposable — it may be deleted at any time and the only consequence is a slower page.

Fare observations are not like that. **Nobody else remembers what LIM–SCL cost on 17 August 2026.** Google Flights answers what it costs today and has no endpoint for what it cost last month; the paid sources that expose any history at all were surveyed and rejected in decision 12.2. The archive is the sole copy of its own contents, and it is built one observation at a time over months.

Applying the cache's write model to it would mean reading the whole series, appending one row, and rewriting the file — where any failure between truncate and write costs every observation ever collected, and where the cost of a write grows with the length of the history it is protecting.

## Decision

### 1. Fare snapshots are appended, never replaced

`services/api/app/services/fare_history.py` writes JSONL — one file per route, one line per observation, opened in append mode:

```python
with path.open("a", encoding="utf-8") as handle:
    handle.write(json.dumps(row, ensure_ascii=False) + "\n")
```

Appending is O(1), touches nothing already on disk, and bounds the worst case at the last line rather than the whole series. There is no atomic-rename dance because there is nothing to protect from a partial write except the row being written.

### 2. The archive lives beside the cache, not inside it

`config.fares_dir()` returns `.local-data/fares/`, separate from `.local-data/bars/`. Same data plane, opposite disposability: anything written to prune the cache must not find the archive.

### 3. A corrupt line costs that line; a corrupt file is an error

A line that will not parse is skipped, matching `BarCache`'s rule that an unreadable file is a miss rather than a failure. But if **every** line is unreadable, that is a format change rather than a bad row, and it is logged at error level. This was not theoretical: renaming the offer keys mid-development made a two-line archive read as no history at all, and the only trace was a warning beside an empty chart.

### 4. The stored shape is the wire shape

Offer rows are written with the same camelCase keys the API serves, spelled out rather than produced by `asdict`. A file meant to be read by a human years from now should not carry `airlineName` at one nesting level and `airline_name` at the next.

### 5. Route history is keyed by city pair; departure date is a field

One file holds every departure ever watched for a pair. Readers filter by `flightDate` before charting, because two departures are two series and the step between them is not a price movement.

## Consequences

**Good.**

- The write cost does not grow with the history, and a failure cannot reach observations already recorded.
- The file is greppable and appendable by anything, which matters for a store whose value is that it survives this codebase.
- The split from `bars/` makes "safe to delete" a property of a directory rather than of a comment.

**Bad, accepted.**

- Reading is a full scan. At one snapshot per route per day this is hundreds of lines a year, which is nothing; at a hundred routes polled hourly it would not be. The plan records compaction as future work rather than building a rotation scheme for a problem that does not exist yet.
- There is no index. Filtering by capture date is a string comparison per line, which is why the bounds are inclusive prefixes rather than parsed dates.
- Two stores now exist on disk with different write models, and choosing between them is a judgement. The rule is the one above: replace what upstream can re-answer, append what only we remember.

**Not decided here.** Whether the archive eventually moves to a cloud store. That question belongs with the provider question (decision 12.9) — the collector is a stateless command precisely so the answer can change without a rewrite.
