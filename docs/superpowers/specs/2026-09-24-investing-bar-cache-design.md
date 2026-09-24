# Investing bar reuse and browser persistence

The chart must paint a previously viewed symbol/timeframe/extended series immediately during a swap or reload, even when its provider refresh is due. Keep the existing collector as the authority for fresh bars and preserve its current polling schedule. A first visit with no saved series still waits for the collector.

The chart query remains keyed by symbol, timeframe, and extended flag. Keep successful query data in memory for the page session. On a cache miss, read a dedicated IndexedDB store before the network request and publish a validated saved response into the query while the request remains in flight. Read a valid but expired Supabase `market_bars` row as a stale initial response, then continue waiting for the collector; a successful refresh replaces the stale response. Persist only validated OHLCV series, metadata and capture time. Scope browser records to the authenticated owner and clear them on sign-out. IndexedDB errors must degrade to the current network path.

An older asynchronous response must not overwrite newer bars, and a different symbol or extended variant must never be shown under the selected chart. Mark an expired initial response as delayed until a fresh refresh succeeds. Avoid persisting credentials, quotes, alerts, or other owner documents. Bound persistent storage and discard incompatible schema versions.

Measure network request counts and time to first chart data before and after for A→B→A within a session, return after five minutes, and return after a browser reload. Browser-authenticated timing remains an operator measurement; automated tests cover ordering, scope, fallback and persistence.
