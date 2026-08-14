import { useCallback, useEffect, useRef, useState } from 'react';

import { openQuoteStream, type Tick } from '@/features/investing/data/quoteStream';
import { FALL_GRACE_MS, latch, type Latch } from '@/features/investing/lib/latch';

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
 * A sweep later discards only overlays whose exchange timestamp predates that
 * sweep. Untimestamped ticks are retained: their order against REST cannot be
 * proved, and replacing a potentially newer live reading with an older sweep is
 * the worse visible failure.
 *
 * Ticks are coalesced to one render per animation frame. The API already sends
 * at most one message per symbol per quarter second, but several symbols moving
 * together should still be one render rather than one each.
 *
 * `live` rises at once and falls slowly. It selects the sweep interval, and
 * TanStack rebuilds the refetch timer whenever that changes — so a value that
 * flips faster than the interval it picks means the timer never fires and the
 * sweep stops. See `lib/latch`.
 */
export type QuoteStreamState = {
  ticks: Map<string, Tick>;
  live: boolean;
  /** Drops only ticks known to predate a REST sweep (seconds since epoch). */
  discardTicksBefore: (sweepAt: number) => void;
};

export function useQuoteStream(symbols: string[]): QuoteStreamState {
  const [ticks, setTicks] = useState<Map<string, Tick>>(() => new Map());
  const [connection, setConnection] = useState<Latch>(() => latch(false));

  // Joined so the effect keys on what the symbols are rather than on the array
  // that held them, which is new on every render of the page above.
  const key = symbols.join(',');
  const frame = useRef(0);
  const discardTicksBefore = useCallback((sweepAt: number) => {
    setTicks((current) => {
      const next = new Map(
        [...current].filter(([, tick]) => tick.time === null || tick.time > sweepAt),
      );
      return next.size === current.size ? current : next;
    });
  }, []);

  useEffect(() => {
    if (!key) {
      setTicks(new Map());
      setConnection((current) => current.lower(performance.now()));
      return;
    }

    // Starting empty on a change of symbols: a tick for a symbol no longer
    // followed is not worth carrying, and every followed one arrives again
    // within a beat. The latch is deliberately not reset — reopening for a new
    // symbol set is not an outage.
    setTicks(new Map());

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

      setTicks((current) => {
        const next = new Map(current);
        for (const [symbol, tick] of batch) {
          const previous = next.get(symbol);
          if (
            !previous ||
            tick.time === null ||
            previous.time === null ||
            tick.time >= previous.time
          ) {
            next.set(symbol, tick);
          }
        }
        return next;
      });
    };

    const close = openQuoteStream(key.split(','), {
      onOpen: () => setConnection((current) => current.raise()),
      onError: () => setConnection((current) => current.lower(performance.now())),
      onTicks: (incoming) => {
        for (const tick of incoming) queued.set(tick.symbol, tick);
        if (!frame.current) frame.current = requestAnimationFrame(flush);
      },
    });

    // A fall is only *asked for* by an error; it lands here, once the grace has
    // passed with nothing having come back.
    const settling = setInterval(
      () => setConnection((current) => current.settle(performance.now())),
      FALL_GRACE_MS / 3,
    );

    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
      frame.current = 0;
      clearInterval(settling);
      close();
    };
  }, [key]);

  return { ticks, live: connection.value, discardTicksBefore };
}
