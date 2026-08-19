import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { useFareHistory } from '@/features/airfare/hooks/useFareHistory';

/**
 * Which departures the archive is asked about.
 *
 * The whole of 12.131 lands here: `departure` is a prefix, so a watched month
 * and one focused day inside it are the same request with a longer string. The
 * baseline and the heartbeat counts come back narrowed to whichever was sent,
 * which is what stops the detail panel printing March's "Looks taken" under a
 * heading that names the 9th.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIM_MAD: FareRoute = {
  origin: 'LIM',
  destination: 'MAD',
  month: '2027-03',
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
  it('asks about the whole month when no day has been focused', async () => {
    const urls = stubHistory();
    renderHook(() => useFareHistory(LIM_MAD), { wrapper });

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(new URL(urls[0], 'http://x').searchParams.get('departure')).toBe('2027-03');
  });

  it('narrows onto the focused day, which is the same request one character longer', async () => {
    // 12.131. Not a second endpoint and not a second parameter: `2027-03-09`
    // is a prefix of exactly one departure the way `2027-03` is a prefix of
    // thirty-one, because these keys truncate the way the calendar does.
    const urls = stubHistory();
    renderHook(() => useFareHistory({ ...LIM_MAD, focusDate: '2027-03-09' }), { wrapper });

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(new URL(urls[0], 'http://x').searchParams.get('departure')).toBe('2027-03-09');
  });

  it('does not serve the month it already holds when a day is focused', async () => {
    /*
     * The focus is part of the query key as well as the request. Without that,
     * setting a focus on a month already in the cache would hand back the
     * month's baseline and the month's heartbeat counts under a heading naming
     * one day — the page saying two different things about one route and
     * fetching nothing to find out which.
     */
    const urls = stubHistory();
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const shared = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { rerender } = renderHook((route: FareRoute) => useFareHistory(route), {
      wrapper: shared,
      initialProps: LIM_MAD,
    });
    await waitFor(() => expect(urls).toHaveLength(1));

    rerender({ ...LIM_MAD, focusDate: '2027-03-09' });
    await waitFor(() => expect(urls).toHaveLength(2));
    expect(new URL(urls[1], 'http://x').searchParams.get('departure')).toBe('2027-03-09');
  });
});
