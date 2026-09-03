import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  cadenceFor,
  makeIsExtended,
  regimeAt,
  type Regime,
} from '@/features/investing/lib/session';
import { getBars, type Bar } from '@/shared/api/market';

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

export function useCandles(symbol: string, timeframe: string): Candles {
  const regime = useRegime();
  const [sessions, setSessions] = useState<Map<string, boolean>>(() => new Map());
  const hasSession = sessions.get(symbol) ?? true;
  const wantExtended = hasSession && regime !== 'regular';

  const query = useQuery({
    // The flag is part of the key: the two variants are different series, and
    // one must not be served from the other's cache entry.
    queryKey: ['market', 'bars', symbol, timeframe, wantExtended],
    queryFn: () => getBars(symbol, timeframe, wantExtended),
    enabled: Boolean(symbol),
    refetchInterval: candleRefetchInterval(regime, timeframe, hasSession),
  });

  const provider = query.data?.provider ?? '';
  const reportedSession = query.data?.hasSession ?? hasSession;
  const bars = useMemo(() => query.data?.bars ?? [], [query.data]);

  // Reported session support is remembered per symbol, purely as a function of
  // the freshest query response, so it is adjusted here during render instead
  // of from an effect.
  const nextHasSession = query.data?.hasSession;
  if (nextHasSession !== undefined && sessions.get(symbol) !== nextHasSession) {
    setSessions((current) => new Map(current).set(symbol, nextHasSession));
  }

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
    extended: query.data?.extended ?? false,
    isGhost,
    isPending: query.isPending,
    // React Query intentionally retains successful data when a background
    // refresh fails. That is degraded data, not a fatal empty chart.
    isStale: (query.data?.stale ?? false) || (query.isError && query.data !== undefined),
    isError: query.isError && query.data === undefined,
    refetch: () => void query.refetch(),
  };
}
