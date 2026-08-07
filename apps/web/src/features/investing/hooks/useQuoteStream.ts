import { useEffect, useRef, useState } from 'react';

import { openQuoteStream, type Tick } from '@/features/investing/data/quoteStream';

/**
 * The newest tick per symbol, and whether the stream is carrying.
 *
 * Deliberately knows nothing about quotes. The sweep is what a row is built
 * from — it has the previous close, the name and the currency — and this is
 * only what has happened since. Keeping them apart means a refetch cannot be
 * undone by a stale tick, a tick cannot be mistaken for a fetched answer, and
 * the page can ask whether the stream is alive *before* it decides how often to
 * sweep, which is the order those two facts actually depend on each other in.
 *
 * Ticks are coalesced to one render per animation frame. The API already sends
 * at most one message per symbol per quarter second, but several symbols moving
 * together should still be one render rather than one each.
 */
export type QuoteStreamState = {
  ticks: Map<string, Tick>;
  live: boolean;
};

export function useQuoteStream(symbols: string[]): QuoteStreamState {
  const [state, setState] = useState<QuoteStreamState>(() => ({ ticks: new Map(), live: false }));

  // Joined so the effect keys on what the symbols are rather than on the array
  // that held them, which is new on every render of the page above.
  const key = symbols.join(',');
  const frame = useRef(0);

  useEffect(() => {
    if (!key) {
      setState({ ticks: new Map(), live: false });
      return;
    }

    // Starting empty on a change of symbols: a tick for a symbol no longer
    // followed is not worth carrying, and every followed one arrives again
    // within a beat.
    setState({ ticks: new Map(), live: false });

    /*
     * Keyed by symbol rather than a list. A background tab never runs an
     * animation frame, so the queue would otherwise grow for as long as the tab
     * stays hidden — overnight, on a market that ticks every second, without
     * bound. Keyed, it cannot exceed the number of symbols followed, and what
     * survives is the newest price for each, which is the only part worth
     * keeping anyway.
     */
    let queued = new Map<string, Tick>();

    const flush = () => {
      frame.current = 0;
      if (!queued.size) return;
      const batch = queued;
      queued = new Map();

      setState((current) => {
        const ticks = new Map(current.ticks);
        for (const [symbol, tick] of batch) ticks.set(symbol, tick);
        return { ...current, ticks };
      });
    };

    const close = openQuoteStream(key.split(','), {
      onOpen: () => setState((current) => ({ ...current, live: true })),
      onError: () => setState((current) => ({ ...current, live: false })),
      onTicks: (incoming) => {
        for (const tick of incoming) queued.set(tick.symbol, tick);
        if (!frame.current) frame.current = requestAnimationFrame(flush);
      },
    });

    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      close();
    };
  }, [key]);

  return state;
}
