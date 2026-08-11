import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePortfolio } from '@/features/investing/hooks/usePortfolio';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function stubPortfolio(initial: unknown) {
  let stored = structuredClone(initial);
  const writes: unknown[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        stored = JSON.parse(String(init?.body)).value;
        writes.push(structuredClone(stored));
        return Response.json({ key: 'portfolio', value: stored });
      }
      return Response.json({ key: 'portfolio', value: stored });
    }),
  );

  return {
    writes,
    get stored() {
      return stored;
    },
  };
}

describe('usePortfolio storage sync', () => {
  it('hydrates positions and persists adds, edits, and removals', async () => {
    const api = stubPortfolio({
      version: 1,
      positions: [{ symbol: 'AAPL', quantity: 1, averageCost: 100 }],
    });
    const { result } = renderHook(() => usePortfolio(), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.portfolio.positions).toEqual([
      { symbol: 'AAPL', quantity: 1, averageCost: 100 },
    ]);

    await act(async () => {
      await result.current.set('msft', 2, 400);
    });
    expect(result.current.portfolio.positions).toEqual([
      { symbol: 'AAPL', quantity: 1, averageCost: 100 },
      { symbol: 'MSFT', quantity: 2, averageCost: 400 },
    ]);
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(api.stored).toEqual(result.current.portfolio));

    await act(async () => {
      await result.current.set('aapl', 1.5, 120);
    });
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() =>
      expect(api.stored).toEqual({
        version: 1,
        positions: [
          { symbol: 'AAPL', quantity: 1.5, averageCost: 120 },
          { symbol: 'MSFT', quantity: 2, averageCost: 400 },
        ],
      }),
    );

    await act(async () => {
      await result.current.remove('MSFT');
    });
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() =>
      expect(api.stored).toEqual({
        version: 1,
        positions: [{ symbol: 'AAPL', quantity: 1.5, averageCost: 120 }],
      }),
    );
    expect(api.writes).toHaveLength(3);
  });
});
