import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { useFareHistory } from '@/features/airfare/hooks/useFareHistory';

/**
 * Which departures the archive is asked about.
 *
 * The month, and since 12.260 only ever the month. `departure` is a prefix
 * (12.112), so `2027-03` matches every departure key inside March and the
 * baseline and the heartbeat counts come back for all of them. This suite once
 * covered a second answer — one focused day inside the month — and the point
 * of what is left is that the request is the month even when the same pair is
 * watched twice.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIM_MAD: FareRoute = {
  origin: 'LIM',
  destination: 'MAD',
  months: ['2027-03'],
  currency: 'USD',
};

const EMPTY = {
  origin: 'LIM',
  destination: 'MAD',
  snapshots: [],
  baseline: [],
  health: { lastCheckedAt: null, checks: 0, changes: 0, errors: 0 },
  airports: [],
};

/** `setup.ts` makes an unstubbed `fetch` reject, so nothing here reaches out. */
function stubHistory() {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(Response.json(EMPTY));
    }),
  );
  return urls;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useFareHistory', () => {
  it('asks about the whole month, which is the whole of what a watch is', async () => {
    const urls = stubHistory();
    renderHook(() => useFareHistory(LIM_MAD, LIM_MAD.months[0]), { wrapper });

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(new URL(urls[0], 'http://x').searchParams.get('departure')).toBe('2027-03');
  });

  it('asks separately about a second month of the same pair, not once about both', async () => {
    /*
     * The month is in the query key as well as in the request, and it has to
     * be: two watches on LIM-MAD in different months are two different
     * archives, and serving the second from the first would put March's
     * baseline and March's heartbeat counts under a heading naming April.
     *
     * This is what is left of the case a focus used to make — the same test
     * with `focusDate: '2027-03-09'` in place of the second month.
     */
    const urls = stubHistory();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const shared = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    // One route read at two months, which is what this test now describes: it
    // used to be two routes that happened to share a pair.
    const { rerender } = renderHook(
      ({ route, month }: { route: FareRoute; month: string }) => useFareHistory(route, month),
      { wrapper: shared, initialProps: { route: LIM_MAD, month: '2027-03' } },
    );
    await waitFor(() => expect(urls).toHaveLength(1));

    rerender({ route: { ...LIM_MAD, months: ['2027-03', '2027-04'] }, month: '2027-04' });
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(new URL(urls[1], 'http://x').searchParams.get('departure')).toBe('2027-04');
  });
});
