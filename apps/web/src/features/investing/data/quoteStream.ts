import type { Quote } from '@/shared/api/market';
import {
  subscribeQuotes,
  type QuoteSubscriptionStatus,
} from '@/features/investing/data/supabaseMarket';
import { quoteBus } from '@/features/investing/data/quoteBus';

/**
 * Live prices, pushed rather than asked for.
 *
 * Owner-visible quote rows arrive over Supabase Realtime. Nothing in this file
 * names a provider; the worker is the only upstream-facing component.
 *
 * **This does not replace polling.** A tick is a trade, so a symbol that does
 * not trade says nothing, and a tick never carries a previous close. The sweep
 * is still what a row is built from; this only moves the price on top of it.
 */

/** What the API sends: deliberately thinner than a quote. */
export type Tick = {
  symbol: string;
  price: number;
  marketState: string | null;
  /**
   * Whether this price came from a pre- or post-market session.
   *
   * Sent rather than inferred here. The REST path already computed it on the
   * server, so deriving it in the browser from `marketState` meant one question
   * answered in two places — and the two vocabularies drifted, with the socket
   * emitting an `EXTENDED` that this file had no branch for at all.
   */
  extended: boolean;
  changePercent: number | null;
  time: number | null;
};

/**
 * A tick laid over the quote the sweep produced.
 *
 * The change is recomputed from the previous close rather than taken from the
 * tick, so the percentage keeps the one meaning decision 8.16 gave it — how it
 * is doing today — whichever path the price arrived by. A tick that carried its
 * own percentage would quietly answer a different question during extended
 * hours, and the two would disagree on screen.
 */
export function mergeTick(quote: Quote, tick: Tick): Quote {
  const previousClose = quote.previousClose;
  const change = previousClose === null || previousClose === 0 ? null : tick.price - previousClose;

  return {
    ...quote,
    price: tick.price,
    marketState: tick.marketState ?? quote.marketState,
    extended: tick.extended,
    change,
    changePercent:
      change === null || previousClose === null ? null : (change / previousClose) * 100,
  };
}

/** Applies a batch to a map of quotes, leaving symbols the sweep has not seen. */
export function applyTicks(quotes: Map<string, Quote>, ticks: Tick[]): Map<string, Quote> {
  let changed = false;
  const next = new Map(quotes);

  // A reconnect can replay an older frame after a newer one. Keep one reading
  // per symbol and let its exchange timestamp decide which is current; when an
  // upstream has no timestamp, stream arrival order is the best ordering
  // it gave us.
  const latest = new Map<string, Tick>();
  for (const tick of ticks) {
    const previous = latest.get(tick.symbol);
    if (!previous || isNewerTick(tick, previous)) latest.set(tick.symbol, tick);
  }

  for (const tick of latest.values()) {
    const quote = next.get(tick.symbol);
    // A tick for a symbol the sweep has not delivered yet is dropped rather
    // than invented into a row: there is no previous close to measure it
    // against, and half a row is worse than none.
    if (!quote || sameReading(quote, tick)) continue;
    next.set(tick.symbol, mergeTick(quote, tick));
    changed = true;
  }

  return changed ? next : quotes;
}

function isNewerTick(next: Tick, previous: Tick): boolean {
  if (next.time !== null && previous.time !== null) return next.time >= previous.time;
  return true;
}

function sameReading(quote: Quote, tick: Tick): boolean {
  return (
    quote.price === tick.price &&
    quote.marketState === (tick.marketState ?? quote.marketState) &&
    quote.extended === tick.extended
  );
}

export type QuoteStreamOptions = {
  onTicks: (ticks: Tick[]) => void;
  onOpen?: () => void;
  onError?: () => void;
  /** Injected in tests; Supabase Realtime otherwise. */
  subscribe?: (
    onQuotes: (quotes: Quote[]) => void,
    onStatus: (status: QuoteSubscriptionStatus) => void,
  ) => () => void;
};

/**
 * Opens the stream and returns the function that closes it.
 *
 * Batches are handed on unchanged: the API already coalesces to one message per
 * symbol per interval, and the caller decides how often to render.
 */
export function openQuoteStream(symbols: string[], options: QuoteStreamOptions): () => void {
  if (!symbols.length) return () => {};
  let terminated = false;
  let close: (() => void) | undefined;
  let closeWhenReady = false;
  const stop = () => {
    if (terminated) return;
    terminated = true;
    if (close) close();
    else closeWhenReady = true;
  };
  try {
    close = (options.subscribe ?? subscribeQuotes)(
      (quotes) => {
        if (terminated) return;
        quoteBus.ingest(quotes);
        const wanted = new Set(symbols.map((symbol) => symbol.trim().toUpperCase()));
        const ticks = quotes
          .filter((quote) => wanted.has(quote.symbol))
          .map(({ symbol, price, marketState, extended, changePercent, time }) => ({
            symbol,
            price,
            marketState,
            extended,
            changePercent,
            time,
          }));
        if (ticks.length) options.onTicks(ticks);
      },
      (status) => {
        if (terminated) return;
        if (status === 'SUBSCRIBED') {
          options.onOpen?.();
          return;
        }
        // Realtime's terminal values are strings; unknown terminal values are
        // treated as a dead stream rather than leaking a provider object upward.
        if (
          status === 'CHANNEL_ERROR' ||
          status === 'TIMED_OUT' ||
          status === 'CLOSED' ||
          status !== 'SUBSCRIBED'
        ) {
          stop();
          options.onError?.();
        }
      },
    );
    if (closeWhenReady) close();
    return () => {
      stop();
    };
  } catch {
    terminated = true;
    options.onError?.();
    return () => {};
  }
}
