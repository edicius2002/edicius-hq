import { describe, expect, it, vi } from 'vitest';

import { PRIORITY, QuoteBus, type QuoteBatch } from '@/features/investing/data/quoteBus';
import type { Quote } from '@/shared/api/market';

function quote(symbol: string, price = 100): Quote {
  return {
    symbol,
    price,
    currency: 'USD',
    previousClose: price - 1,
    change: 1,
    changePercent: 1,
    provider: 'test',
    marketState: 'REGULAR',
    name: symbol,
  };
}

function answering(prices: Record<string, number> = {}) {
  const calls: string[][] = [];
  const fetcher = vi.fn(async (symbols: string[]): Promise<QuoteBatch> => {
    calls.push(symbols);
    return { quotes: symbols.map((s) => quote(s, prices[s] ?? 100)), failed: [] };
  });
  return { calls, fetcher };
}

/** Lets every queued continuation run, rather than counting microtask ticks. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A fetcher that only settles when told to, so races can be arranged. */
function deferred() {
  const calls: string[][] = [];
  const releases: ((batch: QuoteBatch) => void)[] = [];
  const fetcher = vi.fn(
    (symbols: string[]) =>
      new Promise<QuoteBatch>((resolve) => {
        calls.push(symbols);
        releases.push(resolve);
      }),
  );
  return { calls, releases, fetcher };
}

describe('caching', () => {
  it('answers a repeat ask from memory', async () => {
    const { calls, fetcher } = answering();
    const bus = new QuoteBus({ fetcher });

    await bus.quotes(['AAPL']);
    const second = await bus.quotes(['AAPL']);

    expect(calls).toHaveLength(1);
    expect(second.quotes[0].symbol).toBe('AAPL');
  });

  it('asks again once the entry is stale', async () => {
    const { calls, fetcher } = answering();
    let now = 0;
    const bus = new QuoteBus({ fetcher, ttlMs: 100, now: () => now });

    await bus.quotes(['AAPL']);
    now = 150;
    await bus.quotes(['AAPL']);

    expect(calls).toHaveLength(2);
  });

  it('only asks for the symbols it does not already hold', async () => {
    const { calls, fetcher } = answering();
    const bus = new QuoteBus({ fetcher });

    await bus.quotes(['AAPL']);
    await bus.quotes(['AAPL', 'MSFT']);

    expect(calls).toEqual([['AAPL'], ['MSFT']]);
  });

  it('normalises symbols so one spelling is one entry', async () => {
    const { calls, fetcher } = answering();
    const bus = new QuoteBus({ fetcher });

    await bus.quotes([' aapl ']);
    await bus.quotes(['AAPL']);

    expect(calls).toHaveLength(1);
  });

  it('drops the oldest entry rather than growing without limit', async () => {
    const { fetcher } = answering();
    const bus = new QuoteBus({ fetcher, maxCacheEntries: 2 });

    await bus.quotes(['A']);
    await bus.quotes(['B']);
    await bus.quotes(['C']);

    expect(bus.stats.cached).toBe(2);
    expect(bus.cached('A')).toBeNull();
    expect(bus.cached('C')).not.toBeNull();
  });
});

describe('deduplication', () => {
  it('joins a request already in flight instead of starting a second', async () => {
    const { calls, releases, fetcher } = deferred();
    const bus = new QuoteBus({ fetcher });

    const first = bus.quotes(['AAPL']);
    const second = bus.quotes(['AAPL']);
    expect(calls).toHaveLength(1);

    releases[0]({ quotes: [quote('AAPL')], failed: [] });
    const [a, b] = await Promise.all([first, second]);

    expect(a.quotes[0].price).toBe(b.quotes[0].price);
    expect(calls).toHaveLength(1);
  });

  it('asks only for the part of an overlapping request that is new', async () => {
    const { calls, releases, fetcher } = deferred();
    const bus = new QuoteBus({ fetcher });

    const first = bus.quotes(['AAPL', 'MSFT']);
    const second = bus.quotes(['MSFT', 'NVDA']);

    expect(calls).toEqual([['AAPL', 'MSFT'], ['NVDA']]);

    releases[0]({ quotes: [quote('AAPL'), quote('MSFT')], failed: [] });
    releases[1]({ quotes: [quote('NVDA')], failed: [] });
    await first;
    const batch = await second;

    // The joined request carried AAPL too; this caller never asked for it.
    expect(batch.quotes.map((q) => q.symbol).sort()).toEqual(['MSFT', 'NVDA']);
  });

  it('lets a failed request be retried rather than remembering the failure', async () => {
    let attempt = 0;
    const fetcher = vi.fn(async (symbols: string[]): Promise<QuoteBatch> => {
      attempt += 1;
      if (attempt === 1) throw new Error('upstream down');
      return { quotes: symbols.map((s) => quote(s)), failed: [] };
    });
    const bus = new QuoteBus({ fetcher });

    await expect(bus.quotes(['AAPL'])).rejects.toThrow('upstream down');
    const recovered = await bus.quotes(['AAPL']);

    expect(recovered.quotes[0].symbol).toBe('AAPL');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe('priority and concurrency', () => {
  it('never runs more than the cap at once', async () => {
    const { calls, releases, fetcher } = deferred();
    const bus = new QuoteBus({ fetcher, maxConcurrent: 2 });

    void bus.quotes(['A']);
    void bus.quotes(['B']);
    void bus.quotes(['C']);
    void bus.quotes(['D']);

    expect(calls).toHaveLength(2);
    expect(bus.stats).toMatchObject({ active: 2, queued: 2 });

    releases[0]({ quotes: [quote('A')], failed: [] });
    await flush();

    // The freed slot is taken by the next in line, and the cap still holds.
    expect(calls).toHaveLength(3);
    expect(bus.stats).toMatchObject({ active: 2, queued: 1 });
  });

  it('serves a chart ahead of work already waiting', async () => {
    const { calls, releases, fetcher } = deferred();
    const bus = new QuoteBus({ fetcher, maxConcurrent: 1 });

    void bus.quotes(['TAPE'], { priority: PRIORITY.tape });
    void bus.quotes(['HEATMAP'], { priority: PRIORITY.heatmap });
    void bus.quotes(['CHART'], { priority: PRIORITY.chart });

    expect(calls).toEqual([['TAPE']]);

    releases[0]({ quotes: [quote('TAPE')], failed: [] });
    await flush();

    // The chart jumped the heatmap that was queued before it.
    expect(calls[1]).toEqual(['CHART']);
  });

  it('keeps the order of asks at the same priority', async () => {
    const { calls, releases, fetcher } = deferred();
    const bus = new QuoteBus({ fetcher, maxConcurrent: 1 });

    void bus.quotes(['FIRST'], { priority: PRIORITY.watchlist });
    void bus.quotes(['SECOND'], { priority: PRIORITY.watchlist });
    void bus.quotes(['THIRD'], { priority: PRIORITY.watchlist });

    releases[0]({ quotes: [quote('FIRST')], failed: [] });
    await flush();

    expect(calls[1]).toEqual(['SECOND']);
  });
});

describe('failures', () => {
  it('reports a refused symbol beside the ones that worked', async () => {
    const fetcher = vi.fn(async (): Promise<QuoteBatch> => {
      return {
        quotes: [quote('AAPL')],
        failed: [{ symbol: 'NOPE', code: 'symbol-not-found', message: 'unknown' }],
      };
    });
    const bus = new QuoteBus({ fetcher });

    const batch = await bus.quotes(['AAPL', 'NOPE']);

    expect(batch.quotes.map((q) => q.symbol)).toEqual(['AAPL']);
    expect(batch.failed).toEqual([
      { symbol: 'NOPE', code: 'symbol-not-found', message: 'unknown' },
    ]);
  });

  it('does not cache a symbol that failed', async () => {
    const fetcher = vi.fn(async (): Promise<QuoteBatch> => ({
      quotes: [],
      failed: [{ symbol: 'NOPE', code: 'symbol-not-found', message: 'unknown' }],
    }));
    const bus = new QuoteBus({ fetcher });

    await bus.quotes(['NOPE']);
    expect(bus.cached('NOPE')).toBeNull();

    await bus.quotes(['NOPE']);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('asks nobody when given nothing', async () => {
    const { fetcher } = answering();
    const bus = new QuoteBus({ fetcher });

    expect(await bus.quotes([])).toEqual({ quotes: [], failed: [] });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
