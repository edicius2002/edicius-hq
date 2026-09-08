import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSentiment } from '@/shared/api/sentiment';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('getSentiment', () => {
  it('requests the gated normalized endpoint and preserves its contract', async () => {
    const payload = {
      source: 'cnn',
      fetchedAt: '2026-01-03T01:00:00Z',
      asOf: '2026-01-02T23:59:55Z',
      stale: false,
      composite: {
        key: 'fear_and_greed',
        label: 'Fear & Greed Index',
        score: 62.5,
        classification: 'greed',
        timestamp: '2026-01-02T23:59:55Z',
        series: [],
      },
      indicators: [],
    };
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      void input;
      return Response.json(payload);
    });
    vi.stubGlobal('fetch', fetch);

    await expect(getSentiment()).resolves.toEqual(payload);
    expect(String(fetch.mock.calls[0][0])).toContain('/api/sentiment');
  });

  it('keeps the browser request alive for two sequential upstream budgets', async () => {
    vi.useFakeTimers();
    const payload = {
      source: 'cnn-mirror',
      fetchedAt: '2026-01-03T01:00:00Z',
      asOf: '2026-01-02T23:59:55Z',
      stale: false,
      composite: {},
      indicators: [],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        return new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), {
            once: true,
          });
          setTimeout(() => resolve(Response.json(payload)), 24_001);
        });
      }),
    );

    const request = getSentiment();
    await vi.advanceTimersByTimeAsync(24_001);

    await expect(request).resolves.toEqual(payload);
  });
});
