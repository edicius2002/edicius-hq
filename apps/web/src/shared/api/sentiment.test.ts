import { afterEach, describe, expect, it, vi } from 'vitest';

import { getSentiment } from '@/shared/api/sentiment';

afterEach(() => vi.unstubAllGlobals());

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
});
