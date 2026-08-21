import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { useFareCalendar } from '@/features/airfare/hooks/useFareCalendar';

/**
 * What the horizon is keyed by, and when it is not asked for at all.
 *
 * Keyed by the city pair alone, because a curve spans every month at once: two
 * watches on the same pair in different months are the same 15 kB row and must
 * not be fetched twice. It is *not* gated on the open chart — see the hook,
 * which records the measurement that settled it.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const MARCH: FareRoute = { origin: 'ARI', destination: 'SCL', month: '2027-03', currency: 'USD' };
const APRIL: FareRoute = { origin: 'ARI', destination: 'SCL', month: '2027-04', currency: 'USD' };

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function stubCalendar() {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(
      JSON.stringify({
        origin: 'ARI',
        destination: 'SCL',
        horizon: {
          capturedAt: '2026-08-19T15:49:46+00:00',
          source: 'google-flights',
          currency: 'USD',
          fromDate: '2026-08-19',
          toDate: '2026-08-20',
          prices: [
            {
              departureDate: '2026-08-19',
              price: 164.88,
              observedAt: '2026-08-19T15:49:46+00:00',
            },
          ],
        },
        health: { lastCheckedAt: null, checks: 1, changes: 1, errors: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

describe('useFareCalendar', () => {
  it('asks for the pair, with no month narrowing it', async () => {
    const fetcher = stubCalendar();
    const { result } = renderHook(() => useFareCalendar(MARCH), { wrapper });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(fetcher).toHaveBeenCalledTimes(1);
    const url = String(fetcher.mock.calls[0][0]);
    expect(url).toContain('/api/fares/calendar?origin=ARI&destination=SCL');
    expect(url).not.toContain('departure');
    expect(result.current.data?.horizon?.prices).toHaveLength(1);
  });

  it('reads one cached curve for two watches on the same pair in different months', async () => {
    stubCalendar();
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const shared = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const first = renderHook(() => useFareCalendar(MARCH), { wrapper: shared });
    await waitFor(() => expect(first.result.current.data).toBeDefined());

    // The second watch has the curve on its very first render rather than a
    // pending state, which is the whole of what keying by the pair buys: a
    // curve spans every month at once, so March's and April's are one row.
    const second = renderHook(() => useFareCalendar(APRIL), { wrapper: shared });
    expect(second.result.current.data).toBeDefined();
    expect(client.getQueryData(['fares', 'calendar', 'ARI', 'SCL'])).toBeDefined();
    expect(client.getQueryCache().findAll({ queryKey: ['fares', 'calendar'] })).toHaveLength(1);
  });

  it('asks for nothing when no route is open', async () => {
    const fetcher = stubCalendar();
    renderHook(() => useFareCalendar(null), { wrapper });
    await Promise.resolve();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
