import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useLayoutEffect, useRef } from 'react';

import {
  chartKey,
  hydrateStoredBars,
  initiallySessionless,
  loadChartBars,
} from '@/features/investing/chart/useCandles';
import { getStoredBarsForSymbols } from '@/shared/api/market';

const SAVED_BATCH_SIZE = 3;
const SAVED_BATCH_TIMEOUT_MS = 8_000;
const PREFETCH_GC_MS = 30 * 60_000;
const PREFETCH_TIMEOUT_MS = 12_000;

/** Warm other owned assets after the visible chart has bars (or has failed). */
export function useAssetPreload(
  symbols: string[],
  selectedSymbol: string,
  timeframe: string,
  extended: boolean,
  enabled: boolean,
): void {
  const queryClient = useQueryClient();
  const selected = useRef(selectedSymbol);
  useLayoutEffect(() => {
    selected.current = selectedSymbol;
  }, [selectedSymbol]);

  useEffect(() => {
    if (!enabled) return;
    const others = [...new Set(symbols)].filter((symbol) => symbol && symbol !== selectedSymbol);
    if (!others.length) return;

    const controller = new AbortController();
    let inFlight: ReturnType<typeof chartKey> | null = null;
    void (async () => {
      // A small batch keeps each response bounded while still avoiding a
      // separate round trip for every asset and timeframe.
      for (const variant of [false, true]) {
        const matching = others.filter(
          (symbol) => (extended && !initiallySessionless(symbol)) === variant,
        );
        for (let offset = 0; offset < matching.length; offset += SAVED_BATCH_SIZE) {
          if (controller.signal.aborted) return;
          const batch = matching.slice(offset, offset + SAVED_BATCH_SIZE);
          try {
            const batchSignal = AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(SAVED_BATCH_TIMEOUT_MS),
            ]);
            const saved = await getStoredBarsForSymbols(batch, variant, batchSignal);
            if (controller.signal.aborted) return;
            hydrateStoredBars(queryClient, saved, new Set(batch), variant);
          } catch {
            if (controller.signal.aborted) return;
            // Other batches can still populate their chart keys.
          }
        }
      }

      // Only the current timeframe is requested upstream for an asset with
      // no saved chart. At most one speculative collector job is in flight.
      for (const symbol of others) {
        if (controller.signal.aborted) return;
        const variant = extended && !initiallySessionless(symbol);
        const key = chartKey(symbol, timeframe, variant);
        if (queryClient.getQueryData(key) !== undefined) continue;
        inFlight = key;
        const timeout = setTimeout(() => {
          if (queryClient.getQueryCache().find({ queryKey: key })?.getObserversCount() === 0)
            void queryClient.cancelQueries({ queryKey: key, exact: true });
        }, PREFETCH_TIMEOUT_MS);
        try {
          await queryClient.prefetchQuery({
            queryKey: key,
            queryFn: ({ signal }) => loadChartBars(queryClient, symbol, timeframe, variant, signal),
            gcTime: PREFETCH_GC_MS,
            retry: false,
          });
        } finally {
          clearTimeout(timeout);
          inFlight = null;
        }
      }
    })();

    return () => {
      controller.abort();
      if (
        inFlight &&
        inFlight[2] !== selected.current &&
        queryClient.getQueryCache().find({ queryKey: inFlight })?.getObserversCount() === 0
      )
        void queryClient.cancelQueries({ queryKey: inFlight, exact: true });
    };
  }, [enabled, extended, queryClient, selectedSymbol, symbols, timeframe]);
}
