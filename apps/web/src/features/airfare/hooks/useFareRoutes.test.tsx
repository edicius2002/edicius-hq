import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { useFareRoutes } from '@/features/airfare/hooks/useFareRoutes';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TODAY = '2026-08-17';

const LIM_SCL: FareRoute = {
  origin: 'LIM',
  destination: 'SCL',
  month: '2026-10',
  currency: 'USD',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function stubRoutes(initial: unknown) {
  let stored = structuredClone(initial);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        stored = JSON.parse(String(init?.body)).value;
        return Response.json({ key: 'airfare-routes', value: stored });
      }
      return Response.json({ key: 'airfare-routes', value: stored });
    }),
  );

  return {
    get stored() {
      return stored;
    },
  };
}

describe('useFareRoutes storage sync', () => {
  it('hydrates stored routes and persists an add', async () => {
    const api = stubRoutes({ version: 1, routes: [] });
    const { result } = renderHook(() => useFareRoutes(TODAY), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.routes).toEqual([]);

    await act(async () => {
      await result.current.add({ ...LIM_SCL, origin: 'lim' });
    });
    expect(result.current.routes).toEqual([LIM_SCL]);

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(api.stored).toEqual({ version: 1, routes: [LIM_SCL] }));
  });

  it('persists a removal', async () => {
    const api = stubRoutes({ version: 1, routes: [LIM_SCL] });
    const { result } = renderHook(() => useFareRoutes(TODAY), { wrapper });

    await waitFor(() => expect(result.current.routes).toHaveLength(1));

    await act(async () => {
      await result.current.remove(result.current.idOf(LIM_SCL));
    });
    expect(result.current.routes).toEqual([]);

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(api.stored).toEqual({ version: 1, routes: [] }));
  });

  it('repairs a stored document rather than handing the UI a shape to re-check', async () => {
    stubRoutes({ version: 1, routes: [{ origin: 'lim', destination: 'scl', month: 'soon' }] });
    const { result } = renderHook(() => useFareRoutes(TODAY), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.routes).toEqual([]);
  });

  it('offers only the months the calendar has not finished with for collection', async () => {
    stubRoutes({
      version: 1,
      routes: [LIM_SCL, { ...LIM_SCL, month: '2026-07' }],
    });
    const { result } = renderHook(() => useFareRoutes(TODAY), { wrapper });

    await waitFor(() => expect(result.current.routes).toHaveLength(2));
    expect(result.current.collectable).toEqual([LIM_SCL]);
  });

  it('treats a missing document as an empty watchlist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const { result } = renderHook(() => useFareRoutes(TODAY), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.routes).toEqual([]);
    expect(result.current.isError).toBe(false);
  });
});
