# Investing live cadence design

## Intent

Make watchlist prices and the active asset's candle react more promptly while the
Pi remains the only provider-facing runtime. The user requested a branch and
measurements after the proposed 250 ms quote publication and 2 s Yahoo candle
poll changes.

## Scope and constraints

- Keep the existing owner-scoped Supabase Broadcast path and change-only tick batches.
- Publish pending quote and bar changes on a 250 ms worker cycle. A quiet market
  still sends no broadcast request.
- Poll only the focused Yahoo candle every 2 s after a successful fetch. Keep
  Binance's push stream and the existing Yahoo error backoff.
- Retain historical candle and REST snapshot cadences; they do not set the live
  update rate.
- Compare measured local publisher and Yahoo poll intervals before and after.
  Production end-to-end latency needs a deployed worker and authenticated browser.

## Approaches

1. Shorten the two live cycles to 250 ms and 2 s. This directly addresses the
   proposed latency targets, while increasing broadcast opportunities and focused
   Yahoo requests. Chosen for this branch.
2. Shorten browser REST polling. This only rereads snapshots and adds Supabase
   traffic, so it does not improve the live path.
3. Replace the transport or provider. That is a larger change and cannot be
   justified without measured gaps in the present path.

## Validation

Tests must observe publication within 400 ms, continued change-only behavior,
and two-second Yahoo poll spacing. A controlled timing probe reports observed
intervals with the current and baseline implementations. No production deploy
or user document mutation is part of this branch.
