# Investing timeframe preload

## Intent

Once a symbol's visible chart has loaded, fetch its other six timeframes in the background so subsequent timeframe changes paint from the existing owner-scoped chart cache. Keep the visible request ahead of speculative work. Shorten the delay between a completed collector request and the browser receiving it.

## Constraints

- Keep the chart key `(symbol, timeframe, extended)` and the current React Query, IndexedDB, and Supabase cache validation rules.
- The worker remains the sole provider-facing runtime. Background browser work uses the existing request path and is limited to one in-flight timeframe per selected symbol.
- Stop obsolete background work when the selected symbol or timeframe changes. A timeframe the user selects takes priority and can reuse its own in-flight query.
- Stale saved bars may paint immediately while a refresh proceeds. Avoid background polling after preloading; only the visible timeframe retains its existing poll cadence.
- Preserve the current 90-second request deadline and fallback reconciliation when Realtime is unavailable.

## Approach

Share the chart's query function between the visible query and background prefetches. Schedule the other timeframes after the visible request settles, one at a time. Reuse cached queries and skip a network request while a series is fresh. Cancel unobserved prefetches when the selection changes, bound each speculative request to twelve seconds, and retain speculative queries in memory for at most 30 minutes. The twelve-second budget covers the measured 24-hour p95 queue and worker times plus browser transport. A saved series keeps its original capture time in React Query so cancellation or refresh failure cannot make it appear fresh. Reconcile a queued collector request every 750 ms for the first eight seconds, then use the existing two-second interval to limit idle traffic.

Other approaches considered: firing six requests at once would deepen the worker's serial queue and delay a user-selected timeframe; a worker-only prewarm would not hydrate the browser cache until another read and would require a broader queue-priority change. These can be revisited if measured switching remains slow.

## Verification

Hook tests prove all six sibling frames are warmed, only one is in flight, selected-frame reuse, priority on a different frame, cancellation on symbol change, bounded stalls, and stale capture times. Transport tests prove a completed row is found in under one second without relying on Realtime and that checks slow down after eight seconds. Run Investing tests and TypeScript. A production browser remeasurement is a separate deployment verification; this workspace does not deploy automatically.
