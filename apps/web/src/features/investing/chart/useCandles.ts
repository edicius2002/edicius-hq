import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import {
  cadenceFor,
  makeIsExtended,
  regimeAt,
  type Regime,
} from '@/features/investing/lib/session';
import {
  liveBarKey,
  mergeLiveBars,
  type LiveBarContext,
  type LiveBarUpdate,
} from '@/features/investing/data/liveBars';
import type { Tick } from '@/features/investing/data/quoteStream';
import { useChartFocus } from '@/features/investing/hooks/useChartFocus';
import { marketBarCache } from '@/features/investing/data/marketBarCache';
import { getBars, getStoredBars, type Bar, type BarsResponse } from '@/shared/api/market';
import { supabase } from '@/shared/supabase/client';

/**
 * Bars for one symbol, at the cadence the session deserves.
 *
 * The extended-hours overlay is not accumulated and never cleared by hand: the
 * regime decides whether to *ask* for pre- and post-market bars at all. Outside
 * the session we request them and they appear; at the open we stop requesting
 * them and they are gone, for good, because each fetch is the whole series
 * rather than an addition to it. That also means reloading at 3am brings them
 * back rather than losing them.
 */

/**
 * How often to poll each timeframe while the market is open.
 *
 * Deliberately a separate number from the server's cache TTL: that one is about
 * not re-asking upstream, this one is about how often the page wants to look.
 * Polling much faster than a tenth of the bar period spends requests without
 * showing anything new.
 */
const POLL_MS: Record<string, number> = {
  '1m': 10_000,
  '5m': 20_000,
  '15m': 30_000,
  '1h': 60_000,
  '1d': 300_000,
  '1w': 600_000,
  '1M': 1_800_000,
};
const TIMEFRAMES = ['1m', '5m', '15m', '1h', '1d', '1w', '1M'] as const;
const PREFETCH_GC_MS = 30 * 60_000;
const PREFETCH_FRAME_TIMEOUT_MS = 12_000;

// The first query needs the same session hint as the API's Binance routing.
// Once history arrives, its hasSession field remains authoritative.
function initiallySessionless(symbol: string): boolean {
  const upper = symbol.trim().toUpperCase();
  return ['USDT', 'USDC', 'BUSD', 'FDUSD'].some(
    (quote) => upper.endsWith(quote) && upper.length > quote.length,
  );
}

function captureTime(): number {
  return Date.now();
}

export function candleRefetchInterval(
  regime: Regime,
  timeframe: string,
  hasSession: boolean,
): number | false {
  const timeframeMs = POLL_MS[timeframe] ?? 60_000;
  // A crypto pair does not close with New York. Its candle has to keep moving
  // through a US night and weekend just as its streamed quote does.
  return hasSession ? (cadenceFor(regime, timeframeMs).barsMs ?? false) : timeframeMs;
}

/** How often to re-ask what regime we are in. A minute is finer than any boundary. */
const REGIME_TICK_MS = 30_000;

export function useRegime(): Regime {
  const [regime, setRegime] = useState<Regime>(() => regimeAt(new Date()));

  useEffect(() => {
    // Compared rather than scheduled: a timer set for 09:30 is missed by a
    // laptop that was asleep, and waking up to a stale regime is worse than
    // asking every half minute.
    const id = setInterval(() => setRegime(regimeAt(new Date())), REGIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  return regime;
}

export type Candles = {
  bars: Bar[];
  provider: string;
  regime: Regime;
  /** Whether the series currently carries extended-hours bars. */
  extended: boolean;
  /** Takes the index too: on a daily chart what marks a bar is being the last. */
  isGhost: (bar: Bar, index: number) => boolean;
  isPending: boolean;
  /** Existing bars are being preserved because their refresh failed. */
  isStale: boolean;
  isError: boolean;
  refetch: () => void;
};

type ChartBars = BarsResponse & { historyAsOf?: number };
type ChartKey = readonly ['market', 'bars', string, string, boolean];

function chartKey(symbol: string, timeframe: string, extended: boolean): ChartKey {
  return ['market', 'bars', symbol, timeframe, extended];
}

function savedBoundary(response: BarsResponse): number {
  return response.capturedAt === undefined ? -Infinity : response.capturedAt / 1000;
}

async function loadChartBars(
  queryClient: QueryClient,
  symbol: string,
  timeframe: string,
  extended: boolean,
  signal: AbortSignal,
): Promise<ChartBars> {
  const startedAt = Date.now();
  const key = chartKey(symbol, timeframe, extended);
  const publishSaved = (saved: BarsResponse) => {
    if (signal.aborted) return;
    const timed: ChartBars = { ...saved, historyAsOf: savedBoundary(saved) };
    const current = queryClient.getQueryData<ChartBars>(key);
    if (current && (current.capturedAt ?? 0) >= (saved.capturedAt ?? 0)) return;
    queryClient.setQueryData<ChartBars>(key, timed, { updatedAt: saved.capturedAt ?? 0 });
  };
  const ownerId = await supabase.auth.getSession().then(
    ({ data }) => data.session?.user.id ?? null,
    () => null,
  );
  if (ownerId && queryClient.getQueryData(key) === undefined) {
    const local = await marketBarCache.read(ownerId, symbol, timeframe, extended);
    if (local) publishSaved(local);
  }
  signal.throwIfAborted();
  const fresh = await getBars(symbol, timeframe, extended, signal, publishSaved);
  signal.throwIfAborted();
  const dated = { ...fresh, capturedAt: fresh.capturedAt ?? captureTime() };
  const current = queryClient.getQueryData<ChartBars>(key);
  const response: ChartBars =
    current && (current.capturedAt ?? 0) > dated.capturedAt
      ? current
      : { ...dated, historyAsOf: Math.min(startedAt, dated.capturedAt) / 1000 };
  if (ownerId) {
    const stored = { ...response };
    delete stored.historyAsOf;
    void marketBarCache.write(ownerId, stored);
  }
  return response;
}

export function useCandles(
  symbol: string,
  timeframe: string,
  tick: Tick | undefined,
  liveBars: Map<string, LiveBarUpdate>,
  options?: { preloadTimeframes?: boolean },
): Candles {
  const clockRegime = useRegime();
  const regime = regimeFromMarketState(tick?.marketState) ?? clockRegime;
  const queryClient = useQueryClient();
  const startPreload = useRef<((activeFrame: string) => void) | null>(null);
  const selectedChart = useRef({ symbol, timeframe, extended: false });
  const cachedRegular = queryClient.getQueryData<ChartBars>([
    'market',
    'bars',
    symbol,
    timeframe,
    false,
  ]);
  const cachedExtended = queryClient.getQueryData<ChartBars>([
    'market',
    'bars',
    symbol,
    timeframe,
    true,
  ]);
  const cachedSeries = cachedRegular ?? cachedExtended;
  const hasSession = cachedSeries?.hasSession ?? !initiallySessionless(symbol);
  const wantExtended = hasSession && regime !== 'regular';
  useLayoutEffect(() => {
    selectedChart.current = { symbol, timeframe, extended: wantExtended };
  }, [symbol, timeframe, wantExtended]);
  useChartFocus({
    symbol,
    timeframe,
    extended: wantExtended,
    active: !hasSession || regime !== 'closed',
  });

  const query = useQuery({
    // The flag is part of the key: the two variants are different series, and
    // one must not be served from the other's cache entry.
    queryKey: chartKey(symbol, timeframe, wantExtended),
    queryFn: ({ signal }) => loadChartBars(queryClient, symbol, timeframe, wantExtended, signal),
    enabled: Boolean(symbol),
    staleTime: POLL_MS[timeframe] ?? 60_000,
    gcTime: Infinity,
    refetchInterval: candleRefetchInterval(regime, timeframe, hasSession),
  });

  const stored = useQuery({
    queryKey: ['market', 'stored-bars', symbol, wantExtended],
    queryFn: ({ signal }) => getStoredBars(symbol, wantExtended, signal),
    enabled: Boolean(symbol && options?.preloadTimeframes),
    staleTime: 0,
    // The individual chart queries retain the bars; do not retain a second bundle.
    gcTime: 0,
    retry: false,
  });

  useEffect(() => {
    if (!options?.preloadTimeframes || !stored.data) return;
    for (const saved of stored.data) {
      if (
        saved.symbol !== symbol ||
        saved.extended !== wantExtended ||
        !TIMEFRAMES.includes(saved.timeframe as (typeof TIMEFRAMES)[number])
      )
        continue;
      const key = chartKey(symbol, saved.timeframe, wantExtended);
      const current = queryClient.getQueryData<ChartBars>(key);
      if (current && (current.capturedAt ?? 0) >= (saved.capturedAt ?? 0)) continue;
      queryClient.setQueryData<ChartBars>(
        key,
        { ...saved, historyAsOf: savedBoundary(saved) },
        { updatedAt: saved.stale ? saved.capturedAt : Date.now() },
      );
    }
  }, [options?.preloadTimeframes, queryClient, stored.data, symbol, wantExtended]);

  useEffect(() => {
    if (!options?.preloadTimeframes || !symbol) {
      startPreload.current = null;
      return;
    }
    let stopped = false;
    let started = false;
    let inFlight: ChartKey | null = null;
    startPreload.current = (activeFrame) => {
      if (started) return;
      started = true;
      void (async () => {
        for (const frame of TIMEFRAMES) {
          if (stopped) return;
          if (frame === activeFrame) continue;
          const key = chartKey(symbol, frame, wantExtended);
          inFlight = key;
          const timeout = setTimeout(() => {
            if (queryClient.getQueryCache().find({ queryKey: key })?.getObserversCount() === 0)
              void queryClient.cancelQueries({ queryKey: key, exact: true });
          }, PREFETCH_FRAME_TIMEOUT_MS);
          try {
            await queryClient.prefetchQuery({
              queryKey: key,
              queryFn: ({ signal }) =>
                loadChartBars(queryClient, symbol, frame, wantExtended, signal),
              staleTime: POLL_MS[frame],
              gcTime: PREFETCH_GC_MS,
              retry: false,
            });
          } finally {
            clearTimeout(timeout);
          }
          inFlight = null;
        }
      })();
    };
    return () => {
      stopped = true;
      startPreload.current = null;
      if (inFlight) {
        const selected = selectedChart.current;
        const becameVisible =
          selected.symbol === inFlight[2] &&
          selected.timeframe === inFlight[3] &&
          selected.extended === inFlight[4];
        if (
          !becameVisible &&
          queryClient.getQueryCache().find({ queryKey: inFlight })?.getObserversCount() === 0
        )
          void queryClient.cancelQueries({ queryKey: inFlight, exact: true });
      }
    };
  }, [symbol, timeframe, wantExtended, options?.preloadTimeframes, queryClient]);

  useEffect(() => {
    if (query.data !== undefined && !query.isFetching) startPreload.current?.(timeframe);
  }, [query.data, query.isFetching, timeframe]);

  // Session changes use another query key for good cache separation. Keep the
  // last successful history for this same chart visible until that variant
  // arrives, while a different symbol or timeframe gets no fallback at all.
  const response = query.data ?? cachedSeries;
  const provider = response?.provider ?? '';
  const reportedSession = response?.hasSession ?? hasSession;
  const authoritative = liveBars.get(liveBarKey({ symbol, timeframe, extended: wantExtended }));
  const context = useMemo<LiveBarContext>(
    () => ({ symbol, timeframe, extended: wantExtended, hasSession }),
    [symbol, timeframe, wantExtended, hasSession],
  );
  const bars = useMemo(
    () => mergeLiveBars(response?.bars ?? [], authoritative, tick, context, response?.historyAsOf),
    [response?.bars, response?.historyAsOf, authoritative, tick, context],
  );

  const isGhost = useMemo(() => {
    // Crypto never has an overlay: a pair's market runs around the clock, so
    // there is no session for a bar to fall outside of. The API says which,
    // rather than this reading a provider's name to work it out.
    const rule = reportedSession ? makeIsExtended(timeframe, regime, bars.length) : null;
    return (bar: Bar, index: number) => (rule ? rule(bar.time, index) : false);
  }, [reportedSession, timeframe, regime, bars.length]);

  return {
    bars,
    provider,
    regime,
    extended: response?.extended ?? false,
    isGhost,
    isPending: query.isPending,
    // React Query intentionally retains successful data when a background
    // refresh fails. That is degraded data, not a fatal empty chart.
    isStale: (response?.stale ?? false) || (query.isError && response !== undefined),
    isError: query.isError && response === undefined,
    refetch: () => void query.refetch(),
  };
}

function regimeFromMarketState(marketState: string | null | undefined): Regime | undefined {
  switch (marketState?.toUpperCase()) {
    case 'REGULAR':
      return 'regular';
    case 'PRE':
    case 'POST':
      return 'extended';
    case 'CLOSED':
      return 'closed';
    default:
      return undefined;
  }
}
