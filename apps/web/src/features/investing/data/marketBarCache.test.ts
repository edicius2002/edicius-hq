import { describe, expect, it } from 'vitest';

import type { BarsResponse } from '@/shared/api/market';
import { createMarketBarCache, type BarCacheStorage } from './marketBarCache';

const response: BarsResponse = {
  symbol: 'AAPL',
  timeframe: '1d',
  provider: 'yahoo',
  extended: false,
  hasSession: true,
  stale: false,
  bars: [{ time: 1, open: 1, high: 2, low: 1, close: 2, volume: 3 }],
};

function memoryStorage(): BarCacheStorage & { rows: Map<string, unknown> } {
  const rows = new Map<string, unknown>();
  return {
    rows,
    read: async (key) => rows.get(key) ?? null,
    write: async (key, value) => {
      rows.set(key, value);
    },
    oldestKeys: async () =>
      [...rows.entries()]
        .sort(
          (a, b) => (a[1] as { savedAt: number }).savedAt - (b[1] as { savedAt: number }).savedAt,
        )
        .map(([key]) => key),
    remove: async (key) => {
      rows.delete(key);
    },
    clear: async () => {
      rows.clear();
    },
  };
}

describe('market bar browser cache', () => {
  it('keeps owners and chart variants separate and marks recovered bars delayed', async () => {
    const cache = createMarketBarCache(memoryStorage());
    await cache.write('owner-a', response);

    expect(await cache.read('owner-a', 'AAPL', '1d', false)).toEqual({
      ...response,
      stale: true,
    });
    expect(await cache.read('owner-b', 'AAPL', '1d', false)).toBeNull();
    expect(await cache.read('owner-a', 'AAPL', '1d', true)).toBeNull();
    expect(await cache.read('owner-a', 'MSFT', '1d', false)).toBeNull();
  });

  it('rejects a corrupt or wrong-version record instead of drawing it', async () => {
    const storage = memoryStorage();
    const cache = createMarketBarCache(storage);
    await cache.write('owner-a', response);
    const key = [...storage.rows.keys()][0];
    const saved = storage.rows.get(key) as Record<string, unknown>;
    storage.rows.set(key, { ...saved, version: 0 });
    expect(await cache.read('owner-a', 'AAPL', '1d', false)).toBeNull();
    storage.rows.set(key, {
      ...saved,
      response: { ...response, bars: [{ ...response.bars[0], close: NaN }] },
    });
    expect(await cache.read('owner-a', 'AAPL', '1d', false)).toBeNull();
  });

  it('bounds retained series and tolerates unavailable browser storage', async () => {
    const storage = memoryStorage();
    let clock = 0;
    const cache = createMarketBarCache(storage, { limit: 2, now: () => ++clock });
    await cache.write('owner-a', response);
    await cache.write('owner-a', { ...response, symbol: 'MSFT' });
    await cache.write('owner-a', { ...response, symbol: 'NVDA' });
    expect(await cache.read('owner-a', 'AAPL', '1d', false)).toBeNull();
    expect(await cache.read('owner-a', 'NVDA', '1d', false)).not.toBeNull();
    expect(storage.rows.size).toBe(2);

    const unavailable = createMarketBarCache({
      ...storage,
      read: async () => {
        throw new Error('IndexedDB disabled');
      },
      write: async () => {
        throw new Error('Quota exceeded');
      },
    });
    await expect(unavailable.read('owner-a', 'AAPL', '1d', false)).resolves.toBeNull();
    await expect(unavailable.write('owner-a', response)).resolves.toBeUndefined();
  });
});
