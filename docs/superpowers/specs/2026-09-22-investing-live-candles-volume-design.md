# Investing Live Candles and Volume Design

## Intent

Investing must move the active candle from the same live price event that moves
the watchlist, while volume remains provider-authoritative. This applies to all
currently supported instruments and chart intervals:

- Yahoo instruments in premarket, regular trading, and after-hours;
- Binance pairs continuously, including nights and weekends; and
- `1m`, `5m`, `15m`, `1h`, `1d`, `1w`, and `1M` charts.

Success means the watchlist price and active candle close cannot visibly
disagree after a live tick. High and low expand in the correct direction, a new
time bucket creates a new provisional candle, and authoritative OHLCV updates
can grow or shrink both the candle and its volume column. No path fabricates
trade volume.

## Current Failure

The worker publishes quote ticks every 500 ms and the browser overlays them on
the swept watchlist quotes. `useCandles`, however, only reads complete bar
responses on a separate 10-second-to-30-minute polling schedule. The live tick
map never reaches the candle series, and the live wire contract carries no
volume. `CandleChart` already redraws correctly whenever its `bars` input
changes, so the fault is in the data flow rather than the canvas renderer.

The provider capabilities also differ:

- Binance exposes native kline streams with complete OHLCV for every supported
  interval, updating every one to two seconds.
- Yahoo's pricing stream exposes price and session but does not reliably expose
  volume during extended hours. A live premarket capture on 2026-09-22 carried
  TSLA price, timestamp, session, and change percentage but omitted day volume.
  Treating tick count, last quantity, or a rolling statistic as candle volume
  would therefore create plausible-looking but false bars.

The design uses a shared price overlay plus provider-authoritative bar
snapshots. Binance supplies snapshots natively. Yahoo builds the active bar
from short-range chart responses that include pre/post-market data.

## Data Flow

### One price event for watchlist and candle

The existing owner-private quote Broadcast remains the live price source. The
page passes the same newest `Tick` object to both quote merging and candle
merging in one React render:

1. `applyTicks` overlays it on the swept quote map used by Watchlist, Positions,
   Ticker Tape, and alerts.
2. A pure live-candle merge overlays it on the selected chart's authoritative
   bar base.

The price overlay updates `close`, raises `high`, lowers `low`, and leaves
`open` and `volume` unchanged. If the tick belongs to a later bucket, it appends
a provisional candle whose open, high, low, and close all equal the tick price
and whose volume is zero until an authoritative bar arrives. It never assigns a
tick to an earlier bucket.

### Active-chart focus lease

Fetching live bars for every watched symbol and all seven intervals would turn
one visible chart into hundreds of upstream streams or requests. The browser
instead advertises only charts that are actually visible.

An authenticated tab joins the private topic `market-focus:<owner UUID>` and
broadcasts event `focus` with:

```json
{
  "clientId": "random per-tab identifier",
  "symbol": "AAPL",
  "timeframe": "15m",
  "extended": true,
  "active": true
}
```

The tab sends immediately on load and selection changes, then every 15 seconds.
On clean disposal it sends `active: false`. The worker records receipt time
using its own monotonic clock and expires a lease after 45 seconds, so a client
cannot extend a lease by forging a future timestamp. It validates normalized
symbols, the timeframe allowlist, booleans, and a bounded client identifier.
Expired leases are removed before enforcing a maximum of eight concurrent
leases; if the maximum is reached, the oldest lease is replaced. Identical
focus tuples from multiple tabs share one upstream subscription or poll.

The focus is ephemeral and never enters an application table. A worker restart
loses it safely; open tabs restore it on their next heartbeat. The existing
historical bar query remains the initial-load and disconnected fallback.

### Authoritative bar Broadcast

The worker publishes live bar snapshots on the existing private outbound topic
`market-quotes:<owner UUID>` with event `bars`:

```json
{
  "bars": [
    {
      "symbol": "AAPL",
      "timeframe": "15m",
      "extended": true,
      "asOf": 1790076602.25,
      "bar": {
        "time": 1790075700,
        "open": 251.1,
        "high": 252.4,
        "low": 250.9,
        "close": 252.2,
        "volume": 18432
      }
    }
  ]
}
```

`asOf` is the provider time through which the snapshot is complete. The worker
coalesces repeated updates by `(symbol, timeframe, extended)` and emits at most
one newest changed bar per 500 ms Broadcast window. A volume-only change is a
visible change and must not be deduplicated. These messages do not update
PostgreSQL application tables.

## Provider Acquisition

### Binance

For every unique active focus, the Binance adapter subscribes to
`<symbol>@kline_<interval>` on a combined connection. All seven application
intervals map directly to Binance intervals. The adapter validates and
normalizes start time, event time, OHLC, base-asset volume, and closed state,
then emits the complete current bar.

Changing or expiring a focus rebuilds the desired combined subscription. A
reconnect subscribes to the whole current set so it cannot drift. Quote ticker
streaming remains separate because it carries the rolling percentage used by
watchlist metadata. Kline close is authoritative for the chart; a newer ticker
tick may temporarily overlay its close until the next kline event.

### Yahoo

Yahoo live bars are polled only for unique active focus tuples, once immediately
and then no faster than every five seconds while the requested session can
trade. The adapter uses short-range chart requests with `includePrePost=true`.
It does not fetch the full historical series on every live poll.

The adapter constructs the selected current bar as follows:

- `1m`, `5m`, `15m`, and `1h`: aggregate authoritative one-minute bars into the
  current provider/session-aligned bucket. Hourly regular buckets are anchored
  at 09:30 New York time; premarket and postmarket buckets are anchored at
  04:00 and 16:00 respectively.
- `1d`: aggregate today's one-minute bars. With `extended=false`, include only
  regular minutes; with `extended=true`, include every available premarket,
  regular, and after-hours minute.
- `1w` and `1M`: combine completed daily bars in the current New York calendar
  week or month with today's one-minute aggregate. The daily prefix is cached
  for 60 seconds because completed days cannot change at live cadence; the
  current day is refreshed every five seconds.

Aggregation uses first open, maximum high, minimum low, last close, and the sum
of provider volumes. Missing volume remains zero only when the upstream bar
itself reports zero; malformed or incomplete rows are rejected rather than
partially merged. Market holidays need no local calendar because empty provider
responses create no trades or candles.

Yahoo polling stops after the extended session closes and resumes on the next
active lease/session. Binance never stops for the US clock.

## Session and Bucket Semantics

Provider timestamps, not browser arrival time, order all live data. Yahoo uses
`America/New_York`; Binance retains its UTC kline boundaries.

Yahoo `PRE`, `REGULAR`, and `POST` are distinct regimes. Provider `marketState`
may advance the browser's regime before the 30-second wall-clock check. On a
state transition the page immediately updates its focus and invalidates the
correct historical query variant:

- entering `REGULAR` switches to the regular-only series;
- entering `PRE` or `POST` switches to the extended series; and
- entering `CLOSED` stops Yahoo live-bar demand while retaining the last series.

A tick never mutates a candle from another regime. Intraday provisional buckets
use the same 04:00, 09:30, and 16:00 anchors as Yahoo aggregation. Daily,
weekly, and monthly provisional candles use New York calendar boundaries for
Yahoo and UTC boundaries for Binance. The existing ghost rule continues to
render the active daily-or-longer bar translucent outside regular equity hours.

## Browser Reconciliation

The browser keeps two layers per selected series:

1. the most recent complete historical/authoritative bars; and
2. the newest live tick for the selected symbol.

An authoritative live bar replaces the bar with the same start time or appends
it if it is newer. The merge then reapplies only a quote tick whose provider
timestamp is strictly later than `asOf`. Consequently, a Yahoo response that
was already in flight cannot move the chart close behind the watchlist price.
An older bar snapshot or tick is discarded.

When the normal historical query refreshes, its bars become the new base and
any later authoritative live bar and tick are reapplied. This prevents double
counting and makes the overlay disposable. Switching symbol, timeframe, or
extended variant clears overlays synchronously before the previous series can
draw through the next one.

Authoritative OHLCV is allowed to decrease. Exchanges and providers correct
trades; preserving an older larger wick or volume because it looked monotonic
would be false. Passing a new immutable bar array through the existing
indicator and pane hooks causes the candle canvas, volume scale, VWAP, and
other active studies to recompute together.

## Authorization and Validation

A migration adds an authenticated-client Broadcast write policy on
`realtime.messages` only when:

- the extension is `broadcast`; and
- `realtime.topic()` equals `market-focus:` followed by `auth.uid()`.

The existing read policy for `market-quotes:<auth.uid()>` remains unchanged.
Authenticated clients cannot publish to another owner's focus topic or to the
outbound quote topic. The Pi joins focus topics with its service-role secret,
which never enters browser code, payloads, or logs.

Both directions treat Broadcast payloads as untrusted JSON. Invalid focus
messages are ignored and counted without affecting existing leases. Invalid
bar rows are dropped individually; they cannot create partial bars. Error logs
name only sanitized categories, symbols, and timeframes, never credentials or
remote response bodies.

## Failure Handling

Quote streaming, bar acquisition, and historical snapshots fail independently:

- A bar-stream or Yahoo-poll failure retains the last valid candle, applies
  newer price ticks, and leaves volume unchanged.
- Yahoo failures use bounded exponential backoff per focus. A successful poll
  resets the backoff.
- Binance reconnects and resubscribes from the complete active-focus set.
- Losing the browser focus channel does not lower the quote live latch. The
  historical poll remains available, and leases expire on the Pi.
- Losing the outbound bar channel does not stop provider consumers or the
  durable 60-second quote snapshot path. The newest bar remains pending for a
  later Broadcast attempt.
- Worker shutdown cancels focus, polling, and kline tasks promptly before
  closing clients. It never waits out a five-second poll interval.

No failure substitutes tick count, last trade quantity, or rolling 24-hour
volume for candle volume.

## Performance Bounds

- Quote Broadcast remains capped at one batch per 500 ms.
- Bar Broadcast shares the same maximum publication window and emits only
  changed snapshots.
- One Yahoo focus costs at most twelve short-range polls per minute, plus a
  cached daily-prefix refresh for weekly or monthly views.
- Duplicate focus tuples share acquisition work.
- Eight live focus leases bound memory, upstream subscriptions, and Yahoo load.
- PostgreSQL retains only replaceable snapshots at its existing cadence; focus
  and live-bar events create no high-frequency application-table writes.

These bounds preserve ADR 0004: the Pi remains the only provider-facing
runtime, upstream providers remain authoritative for market bars, and Supabase
continues as an owner-scoped cache and transport.

## Verification

Implementation follows test-driven development. Regression coverage must prove
the behavior at the real merge and transport seams.

Backend tests cover:

- Binance kline parsing for all seven interval mappings, including volume-only
  changes, malformed rows, resubscription, and reconnects;
- Yahoo aggregation for every timeframe, pre/regular/post filters, 09:30 hourly
  anchoring, week/month boundaries, zero volume, and downward corrections;
- focus validation, heartbeats, release, expiry, duplicate sharing, multiple
  tabs, and the eight-lease bound;
- changed-bar coalescing, failed Broadcast retry, shutdown cancellation, and
  independence from quote snapshots; and
- owner-topic RLS for authenticated focus publication and denial of cross-owner
  or quote-topic publication.

Frontend tests cover:

- one tick changing both the rendered watchlist value and active candle close;
- rising and falling prices, high/low expansion, and provisional rollover for
  every timeframe and provider calendar;
- pre-to-regular and regular-to-post transitions without cross-session mutation;
- authoritative replacement, downward OHLCV corrections, out-of-order events,
  and replay only when `tick.time > bar.asOf`;
- symbol/timeframe changes clearing overlays; and
- bar-channel failure preserving quote streaming and historical fallback.

Verification commands include the focused tests during red/green cycles, then
the complete web and API test suites, web/API type checks, lint, formatting
check, production build, migration tests, and `git diff --check`. A live smoke
test observes Binance continuously and Yahoo in whichever market session is
available, confirming that watchlist and candle close move together and that
the volume pane accepts authoritative updates.

The current local dependency installations are incomplete (`@supabase/supabase-js`
and `PyJWT` are absent). Before the first red test, dependencies are restored
from the committed lockfile and requirements file; no dependency version change
is part of this feature.

## Out of Scope

- Replacing Yahoo with a paid equities feed.
- Persisting tick-level or live-bar history.
- Inventing volume when a provider has not reported it.
- Supporting intervals or providers not already present in Investing.
- Changing alert, portfolio, or watchlist document semantics.
