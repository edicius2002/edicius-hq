import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { candleRefetchInterval, useCandles } from '@/features/investing/chart/useCandles';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const barsResponse = {
  symbol: 'SPCX',
  timeframe: '15m',
  provider: 'yahoo',
  extended: false,
  hasSession: true,
  stale: false,
  bars: [{ time: 1_786_060_800, open: 1, high: 2, low: 0.5, close: 1.5, volume: 100 }],
};

describe('useCandles', () => {
  it('keeps 24/7 instruments polling while the US market is closed', () => {
    expect(candleRefetchInterval('closed', '1m', false)).toBe(10_000);
    expect(candleRefetchInterval('closed', '1m', true)).toBe(false);
  });

  it('keeps a loaded chart when a background refresh fails', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(Response.json(barsResponse))
      .mockResolvedValueOnce(Response.json({ detail: 'upstream down' }, { status: 502 }));
    vi.stubGlobal('fetch', fetch);

    const { result } = renderHook(() => useCandles('SPCX', '15m'), { wrapper });
    await waitFor(() => expect(result.current.bars).toHaveLength(1));

    await act(async () => result.current.refetch());
    await waitFor(() => expect(result.current.isStale).toBe(true));

    expect(result.current.isError).toBe(false);
    expect(result.current.bars).toHaveLength(1);
  });

  it('still reports a fatal error when no series has ever loaded', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ detail: 'upstream down' }, { status: 502 })),
    );

    const { result } = renderHook(() => useCandles('SPCX', '15m'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(result.current.bars).toEqual([]);
    expect(result.current.isStale).toBe(false);
  });
});
