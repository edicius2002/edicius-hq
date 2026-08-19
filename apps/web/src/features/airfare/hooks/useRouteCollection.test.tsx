import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useRouteCollection } from '@/features/airfare/hooks/useRouteCollection';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIM_CUZ: FareRoute = {
  origin: 'LIM',
  destination: 'CUZ',
  flightDate: '2026-10-17',
  returnDate: null,
  currency: 'USD',
};

const LIM_MAD: FareRoute = {
  origin: 'LIM',
  destination: 'MAD',
  flightDate: '2026-12-01',
  returnDate: '2026-12-20',
  currency: 'USD',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** One collection pass over one route, as the server would report it. */
function passOver(route: FareRoute, overrides: Record<string, unknown> = {}) {
  return {
    startedAt: '2026-08-19T14:00:00+00:00',
    finishedAt: '2026-08-19T14:00:01+00:00',
    source: 'google',
    collected: 1,
    changed: 1,
    failed: 0,
    skipped: [],
    results: [
      {
        origin: route.origin,
        destination: route.destination,
        flightDate: route.flightDate,
        returnDate: route.returnDate,
        ok: true,
        changed: true,
        seeded: 0,
        offers: 9,
        cheapest: 380,
        currency: 'USD',
        errorCode: null,
        errorMessage: null,
        ...overrides,
      },
    ],
  };
}

/**
 * A collect endpoint that answers when it is told to.
 *
 * Held open on purpose: the in-flight state is the thing under test, and a
 * `fetch` that resolves immediately never lets a test see it. `setup.ts` makes
 * an unstubbed `fetch` reject, so nothing here can reach the network by
 * accident.
 */
function stubCollect() {
  const calls: unknown[] = [];
  let release: ((value: Response) => void) | null = null;

  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );

  return {
    calls,
    answer(body: unknown) {
      release?.(Response.json(body));
    },
  };
}

describe('collecting one watched route from its own row', () => {
  it('asks for that route alone, dates and currency included', async () => {
    // The bulk button sends the whole collectable list; a row press must send
    // one route, or pressing it would spend the request budget on eight others.
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_MAD));

    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]).toEqual({
      routes: [
        {
          origin: 'LIM',
          destination: 'MAD',
          flightDate: '2026-12-01',
          returnDate: '2026-12-20',
          currency: 'USD',
        },
      ],
    });
  });

  it('marks only the pressed row as working', async () => {
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    await waitFor(() => expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]));
    expect(result.current.collecting).not.toContain(routeId(LIM_MAD));

    await act(async () => {
      api.answer(passOver(LIM_CUZ));
    });
    await waitFor(() => expect(result.current.collecting).toEqual([]));
  });

  it('refuses a second press of a row that is already collecting', async () => {
    /*
     * The disabled button stops a human double-click, which is several renders
     * apart. Two presses dispatched inside one tick would both see the old
     * state, so the guard that has to hold is the synchronous one — and a
     * doubled press would be two upstream requests for one fare.
     */
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => {
      result.current.collect(LIM_CUZ);
      result.current.collect(LIM_CUZ);
    });

    await waitFor(() => expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]));
    expect(api.calls).toHaveLength(1);
  });

  it('files the outcome under the row that asked for it', async () => {
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    // `mutate` dispatches the request a tick later, so the stub has nothing to
    // release until the call has actually been made.
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await act(async () => {
      api.answer(passOver(LIM_CUZ));
    });

    await waitFor(() => expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(true));
    expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('9 flights');
    expect(result.current.reports.has(routeId(LIM_MAD))).toBe(false);
  });

  it('says so on the row when the call itself fails', async () => {
    // A press that comes back with nothing on screen is a broken button as far
    // as the reader is concerned, whether the failure was the provider's or
    // the API's.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'Too many routes' }, { status: 400 })),
    );
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));

    await waitFor(() => expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(true));
    const report = result.current.reports.get(routeId(LIM_CUZ))!;
    expect(report.ok).toBe(false);
    expect(report.text).toContain('Too many routes');
    expect(result.current.collecting).toEqual([]);
  });

  it('drops a row’s report when the row goes', async () => {
    // Route ids are content, not handles: the same pair on the same dates
    // rebuilds the same id, so a stale line would reappear under a route that
    // had just been added back.
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await act(async () => {
      api.answer(passOver(LIM_CUZ));
    });
    await waitFor(() => expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(true));

    act(() => result.current.forget(routeId(LIM_CUZ)));
    expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(false);
  });
});
