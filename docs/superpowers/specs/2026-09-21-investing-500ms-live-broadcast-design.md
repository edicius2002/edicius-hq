# Investing 500 ms Live Broadcast Design

## Intent

Investing should show provider price changes in under one second while the
Raspberry Pi remains the only provider-facing runtime. The change must not turn
the existing `market_quotes` cache into a high-frequency write log because the
Supabase project has already reported Disk IO budget pressure.

Success means:

- the Pi emits at most one owner-scoped tick batch every 500 ms;
- each batch contains only the newest changed reading per symbol;
- the browser applies valid ticks immediately to quotes already obtained from
  the durable snapshot;
- database snapshots remain available for initial load and recovery;
- a Broadcast outage degrades to snapshot polling without losing the market
  worker or exposing one owner's ticks to another owner.

## Current Failure

The worker receives provider ticks continuously but only calls
`flush_quotes()` from its 30-second reconciliation cycle. Production probing
showed all 13 rows advancing together after roughly 32 seconds. Lowering the
database flush interval to 500 ms would produce up to 2,246,400 row updates per
day for the current 13 symbols, plus WAL, vacuum work, and Postgres Changes.

## Architecture

Use Supabase Realtime Broadcast for the live path and keep PostgreSQL as a
replaceable snapshot:

1. Provider sockets feed `MarketWorker.accept()` exactly as today.
2. The worker retains the newest tick per symbol in a live pending map.
3. An independent 500 ms task compares each pending tick with the last
   successfully broadcast visible reading. It drops unchanged readings and
   sends the remaining ticks as one batch.
4. `CollectorCloud` sends the batch through Supabase's Realtime REST Broadcast
   endpoint to the private topic `market-quotes:<owner UUID>` with event
   `ticks`. This path does not update a PostgreSQL application table.
5. The browser authenticates, joins only its own private topic, validates the
   thin tick batch, and applies followed symbols through the existing
   `useQuoteStream` overlay.
6. The worker continues storing complete `market_quotes` snapshots and running
   REST quote recovery every 60 seconds. Initial page load and disconnected
   clients therefore retain a durable source of truth.

The 500 ms window is a maximum publication rate, not a fabricated heartbeat.
If no visible reading changed, no Broadcast request is sent. A provider that
does not publish a trade cannot produce a new on-screen price.

## Tick Coalescing

The consumer-visible reading is `(price, market_state, extended)`. Provider
timestamps alone do not make a price visibly different and must not cause an
otherwise identical tick to be broadcast. Within one window, a later tick for
the same symbol replaces an earlier one. If a symbol returns to the last
successfully broadcast reading before the window closes, it is omitted.

The batch payload is:

```json
{
  "ticks": [
    {
      "symbol": "AAPL",
      "price": 250.5,
      "marketState": "REGULAR",
      "extended": false,
      "changePercent": 1.2,
      "time": 1790008113.25
    }
  ]
}
```

The last-broadcast marker advances only after Supabase accepts the request. On
a transient rejection, the newest tick remains pending for the next 500 ms
attempt. Repeated frames cannot grow memory beyond the followed symbol count.

## Snapshot Cadence

Thin stream ticks merge into `market_quotes` no more than once per symbol every
60 seconds. Full REST quote recovery remains at 60 seconds because it restores
currency, previous close, name, and other metadata absent from ticks. The two
operations may occur in the same reconciliation cycle; even in that upper-bound
case they produce fewer database row updates than a five-second live table
flush and preserve the current recovery semantics.

## Authorization

A migration adds a `SELECT` policy on `realtime.messages` for authenticated
clients. It permits Broadcast reads only when:

- the extension is `broadcast`; and
- `realtime.topic()` equals `market-quotes:` followed by `auth.uid()`.

There is no authenticated-client insert policy. The Pi publishes with the
existing server-side Supabase secret and `private=true`; the secret never enters
the browser or logs. The browser channel is created with `{ private: true }`.

## Browser Behavior

`subscribeQuoteTicks` resolves the current Supabase session before creating the
private channel. Missing or failed authentication reports a terminal stream
error. Disposal is safe before or after session resolution.

Broadcast payloads are treated as untrusted JSON. Invalid rows are discarded;
valid rows are normalized and passed to `openQuoteStream`. The stream filters
to the requested symbols. Thin ticks do not populate `quoteBus`, because they
lack the complete metadata required to construct a quote. The existing REST
snapshot remains responsible for that metadata.

When the private channel reaches `SUBSCRIBED`, the existing live latch raises.
On `CHANNEL_ERROR`, `TIMED_OUT`, or `CLOSED`, it lowers and the existing query
cadence returns to snapshot polling. Reconnection remains owned by the React
effect rather than by a second transport.

## Failure Handling

- Broadcast timeout, network failure, rate limiting, and 5xx responses are
  retryable. The worker keeps only the newest pending tick for each symbol.
- A permanent 4xx rejection is sanitized; neither response bodies nor secrets
  appear in errors.
- Broadcast failure does not erase or delay the 60-second snapshot path.
- Worker shutdown cancels the 500 ms publisher promptly, then performs the
  existing final snapshot flush.
- A malformed browser payload cannot create a partial quote row; only the
  channel subscription status controls the existing live latch.

## Verification

Backend tests must prove:

- multiple ticks for one symbol become the newest single tick in one 500 ms
  batch;
- unchanged visible readings do not generate another request;
- a failed Broadcast retains the newest tick and retries it;
- publication occurs independently of the 30-second reconciliation loop;
- stopping the worker interrupts the publisher promptly;
- the cloud boundary targets the private owner topic, sends one batch, rejects
  redirects, and sanitizes remote failures;
- database tick snapshots remain bounded to 60 seconds.

Frontend tests must prove:

- the authenticated owner joins the matching private topic;
- valid batched ticks reach `openQuoteStream` without being promoted to full
  quotes;
- malformed rows and symbols outside the requested set are ignored;
- disposal during asynchronous session resolution creates no leaked channel;
- terminal Realtime states lower the existing live latch and leave snapshot
  polling available.

Migration tests must prove that an authenticated user can select Broadcast
messages only for `market-quotes:<auth.uid()>` and cannot publish them.

After deployment, the production probe must observe provider changes reaching
the browser path within a 500 ms publication window plus network latency while
all durable quote rows remain complete. Supabase Disk IO and Realtime event
reports must be checked after the rollout; the live path must not increase
`market_quotes` write frequency above the 60-second snapshot bound.
