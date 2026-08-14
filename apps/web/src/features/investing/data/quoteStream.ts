import { getApiBaseUrl } from '@/shared/api/config';
import type { Quote } from '@/shared/api/market';

/**
 * Live prices, pushed rather than asked for.
 *
 * The API holds the upstream socket and relays here over server-sent events —
 * see plan decision 8.19. Nothing in this file names a provider, and an
 * `EventSource` reconnects by itself, which is most of why it was chosen over a
 * socket in the browser.
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
  // upstream has no timestamp, EventSource arrival order is the best ordering
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

export function streamUrl(symbols: string[]): string {
  const query = new URLSearchParams({ symbols: symbols.join(',') });
  return `${getApiBaseUrl()}/api/market/stream?${query}`;
}

export type QuoteStreamOptions = {
  onTicks: (ticks: Tick[]) => void;
  onOpen?: () => void;
  onError?: () => void;
  /** Injected in tests; the browser's own class otherwise. */
  create?: (url: string) => EventSource;
};

/**
 * Opens the stream and returns the function that closes it.
 *
 * Batches are handed on unchanged: the API already coalesces to one message per
 * symbol per interval, and the caller decides how often to render.
 */
export function openQuoteStream(symbols: string[], options: QuoteStreamOptions): () => void {
  if (!symbols.length) return () => {};

  const create = options.create ?? ((url: string) => new EventSource(url));
  const source = create(streamUrl(symbols));

  source.addEventListener('open', () => options.onOpen?.());
  source.addEventListener('quotes', (event) => {
    try {
      const ticks = JSON.parse((event as MessageEvent<string>).data) as Tick[];
      if (Array.isArray(ticks) && ticks.length) options.onTicks(ticks);
    } catch {
      // A frame we cannot read is a reason to ignore that frame. The stream is
      // an optimisation over the sweep; it must never be able to break it.
    }
  });
  source.addEventListener('error', () => options.onError?.());

  return () => source.close();
}
