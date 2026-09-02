import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePriceAlerts } from '@/features/investing/hooks/usePriceAlerts';
import type { AlertRules } from '@/features/investing/data/priceAlerts';

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

function stubAlertRules(initial: AlertRules) {
  let stored = structuredClone(initial);

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'PUT') {
        stored = JSON.parse(String(init?.body)).value;
        return Response.json({ key: 'alert-rules', value: stored });
      }
      return Response.json({ key: 'alert-rules', value: stored });
    }),
  );

  return {
    get stored() {
      return stored;
    },
  };
}

describe('usePriceAlerts storage sync', () => {
  it('hydrates alerts and persists an add, an edit, a toggle, and a trigger', async () => {
    const api = stubAlertRules({ version: 1, alerts: [] });
    const { result } = renderHook(() => usePriceAlerts(), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.alerts).toEqual([]);

    await act(async () => {
      await result.current.add({ symbol: 'aapl', kind: 'buy', price: 200 });
    });
    expect(result.current.alerts).toHaveLength(1);
    const [added] = result.current.alerts;
    expect(added).toMatchObject({ symbol: 'AAPL', kind: 'buy', price: 200, active: true });
    expect(typeof added.id).toBe('string');

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(api.stored.alerts).toHaveLength(1));

    await act(async () => {
      await result.current.update(added.id, { price: 210 });
    });
    await waitFor(() => expect(result.current.alerts[0].price).toBe(210));

    await act(async () => {
      await result.current.toggle(added.id, false);
    });
    await waitFor(() => expect(result.current.alerts[0].active).toBe(false));

    await act(async () => {
      await result.current.trigger(added.id, 5000);
    });
    await waitFor(() =>
      expect(result.current.alerts[0]).toMatchObject({ active: false, triggeredAt: 5000 }),
    );

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() =>
      expect(api.stored.alerts[0]).toMatchObject({
        symbol: 'AAPL',
        price: 210,
        active: false,
        triggeredAt: 5000,
      }),
    );

    await act(async () => {
      await result.current.remove(added.id);
    });
    expect(result.current.alerts).toEqual([]);
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(api.stored.alerts).toEqual([]));
  });
});
