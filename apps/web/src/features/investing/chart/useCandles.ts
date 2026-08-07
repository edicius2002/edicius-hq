import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';

import {
  cadenceFor,
  hasSession,
  isExtendedBar,
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
  isGhost: (bar: Bar) => boolean;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
};

export function useCandles(symbol: string, timeframe: string): Candles {
  const regime = useRegime();
  const wantExtended = regime !== 'regular';

  const query = useQuery({
    // The flag is part of the key: the two variants are different series, and
    // one must not be served from the other's cache entry.
    queryKey: ['market', 'bars', symbol, timeframe, wantExtended],
    queryFn: () => getBars(symbol, timeframe, wantExtended),
    enabled: Boolean(symbol),
    refetchInterval: cadenceFor(regime, POLL_MS[timeframe] ?? 60_000).barsMs ?? false,
  });

  const provider = query.data?.provider ?? '';
  const bars = useMemo(() => query.data?.bars ?? [], [query.data]);

  const isGhost = useMemo(() => {
    // Crypto never has an overlay: Binance runs around the clock, so there is
    // no session for a bar to fall outside of.
    if (!hasSession(provider)) return () => false;
    return (bar: Bar) => isExtendedBar(bar.time);
  }, [provider]);

  return {
    bars,
    provider,
    regime,
    extended: query.data?.extended ?? false,
    isGhost,
    isPending: query.isPending,
    isError: query.isError,
    refetch: () => void query.refetch(),
  };
}
