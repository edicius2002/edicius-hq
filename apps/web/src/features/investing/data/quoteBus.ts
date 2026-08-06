import { getQuotes, type Quote, type QuoteFailure } from '@/shared/api/market';

/**
 * The client half of the request budget.
 *
 * Upstream tolerates a few hundred requests a day from one address, so the
 * page cannot simply ask for what it wants when it wants it. Four things stand
 * between a panel and the network:
 *
 * - **Deduplication.** A symbol already in flight is joined, not re-requested.
 * - **A TTL.** A symbol asked for twice within the window is answered from memory.
 * - **Priorities.** A chart tick must not queue behind a heatmap sweep.
 * - **A concurrency cap.** Everything else waits its turn.
 *
 * Batching happens above this, at the call site: one ask for twenty symbols,
 * not twenty asks.
 */

/** Lower goes first. The order is the order things matter on screen. */
export const PRIORITY = {
  chart: 0,
  watchlistActive: 1,
  watchlist: 2,
  heatmap: 3,
  tape: 4,
} as const;

export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export type QuoteBusOptions = {
  ttlMs?: number;
  maxConcurrent?: number;
  maxCacheEntries?: number;
  /** Swappable so the bus can be tested without a network. */
  fetcher?: (symbols: string[], signal?: AbortSignal) => Promise<QuoteBatch>;
  now?: () => number;
};

export type QuoteBatch = { quotes: Quote[]; failed: QuoteFailure[] };

type Waiter = {
  symbols: string[];
  priority: number;
  resolve: (batch: QuoteBatch) => void;
  reject: (error: unknown) => void;
  signal?: AbortSignal;
};

const DEFAULTS = {
  ttlMs: 10_000,
  maxConcurrent: 4,
  maxCacheEntries: 256,
};

export class QuoteBus {
  private readonly ttlMs: number;
  private readonly maxConcurrent: number;
  private readonly maxCacheEntries: number;
  private readonly fetcher: NonNullable<QuoteBusOptions['fetcher']>;
  private readonly now: () => number;

  private readonly cache = new Map<string, { at: number; quote: Quote }>();
  private readonly inflight = new Map<string, Promise<QuoteBatch>>();
  private readonly queue: Waiter[] = [];
  private active = 0;

  constructor(options: QuoteBusOptions = {}) {
    this.ttlMs = options.ttlMs ?? DEFAULTS.ttlMs;
    this.maxConcurrent = options.maxConcurrent ?? DEFAULTS.maxConcurrent;
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULTS.maxCacheEntries;
    this.fetcher = options.fetcher ?? ((symbols, signal) => getQuotes(symbols, signal));
    this.now = options.now ?? (() => Date.now());
  }

  /** What is already known and still fresh, without asking anyone. */
  cached(symbol: string): Quote | null {
    const entry = this.cache.get(normalize(symbol));
    if (!entry) return null;
    if (this.now() - entry.at >= this.ttlMs) {
      this.cache.delete(normalize(symbol));
      return null;
    }
    return entry.quote;
  }

  async quotes(
    symbols: string[],
    { priority = PRIORITY.watchlist, signal }: { priority?: number; signal?: AbortSignal } = {},
  ): Promise<QuoteBatch> {
    const wanted = dedupe(symbols);
    if (!wanted.length) return { quotes: [], failed: [] };

    const fresh: Quote[] = [];
    const missing: string[] = [];
    for (const symbol of wanted) {
      const hit = this.cached(symbol);
      if (hit) fresh.push(hit);
      else missing.push(symbol);
    }

    if (!missing.length) return { quotes: fresh, failed: [] };

    // Join whatever is already on its way; only ask for the remainder.
    const joined: Promise<QuoteBatch>[] = [];
    const toRequest: string[] = [];
    for (const symbol of missing) {
      const pending = this.inflight.get(symbol);
      if (pending) joined.push(pending);
      else toRequest.push(symbol);
    }

    if (toRequest.length) {
      const request = this.enqueue({ symbols: toRequest, priority, signal });
      for (const symbol of toRequest) this.inflight.set(symbol, request);
      const settle = () => {
        for (const symbol of toRequest) {
          if (this.inflight.get(symbol) === request) this.inflight.delete(symbol);
        }
      };
      request.then(settle, settle);
      joined.push(request);
    }

    const batches = await Promise.all(joined);
    const quotes = [...fresh];
    const failed: QuoteFailure[] = [];
    const seen = new Set(fresh.map((q) => q.symbol));

    for (const batch of batches) {
      for (const quote of batch.quotes) {
        // A joined request may carry symbols this caller never asked about.
        if (wanted.includes(quote.symbol) && !seen.has(quote.symbol)) {
          seen.add(quote.symbol);
          quotes.push(quote);
        }
      }
      for (const failure of batch.failed) {
        if (wanted.includes(failure.symbol)) failed.push(failure);
      }
    }

    return { quotes, failed };
  }

  private enqueue(waiter: Omit<Waiter, 'resolve' | 'reject'>): Promise<QuoteBatch> {
    return new Promise<QuoteBatch>((resolve, reject) => {
      const entry: Waiter = { ...waiter, resolve, reject };
      // Stable within a priority: an earlier ask at the same level goes first.
      const at = this.queue.findIndex((queued) => queued.priority > entry.priority);
      if (at === -1) this.queue.push(entry);
      else this.queue.splice(at, 0, entry);
      this.pump();
    });
  }

  private pump(): void {
    while (this.active < this.maxConcurrent && this.queue.length) {
      const next = this.queue.shift();
      if (!next) return;
      this.active += 1;

      this.fetcher(next.symbols, next.signal)
        .then((raw) => {
          const batch = asBatch(raw);
          for (const quote of batch.quotes) this.remember(quote);
          next.resolve(batch);
        })
        .catch(next.reject)
        .finally(() => {
          this.active -= 1;
          this.pump();
        });
    }
  }

  private remember(quote: Quote): void {
    if (this.cache.size >= this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(normalize(quote.symbol), { at: this.now(), quote });
  }

  /** Test and diagnostics window; nothing in the product should need it. */
  get stats() {
    return { active: this.active, queued: this.queue.length, cached: this.cache.size };
  }

  clear(): void {
    this.cache.clear();
  }
}

/**
 * The network is a trust boundary, so what comes back is checked rather than
 * assumed. A misconfigured base URL answering with something else must cost an
 * empty panel, not a crashed page.
 */
function asBatch(raw: unknown): QuoteBatch {
  const value = (raw ?? {}) as Partial<QuoteBatch>;
  return {
    quotes: Array.isArray(value.quotes) ? value.quotes : [],
    failed: Array.isArray(value.failed) ? value.failed : [],
  };
}

function normalize(symbol: string): string {
  return symbol.trim().toUpperCase();
}

function dedupe(symbols: string[]): string[] {
  const seen: string[] = [];
  for (const symbol of symbols) {
    const clean = normalize(symbol);
    if (clean && !seen.includes(clean)) seen.push(clean);
  }
  return seen;
}

/** The bus the app uses. Tests build their own. */
export const quoteBus = new QuoteBus();
