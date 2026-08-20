import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useHorizonCollection } from '@/features/airfare/hooks/useHorizonCollection';

/**
 * The collection that adding a route fires by itself.
 *
 * What has to be true of it is one sentence and every test here is a clause of
 * it: the route is watched whatever the upstream does, the reader is told which
 * of the things that can happen happened, and the curve the page is holding is
 * refreshed when — and only when — a new one has actually landed.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIM_SCL: FareRoute = {
  origin: 'LIM',
  destination: 'SCL',
  month: '2027-03',
  currency: 'USD',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** One finished horizon pass over one city pair, as the server reports it. */
function horizonPass(overrides: Record<string, unknown> = {}) {
  return {
    state: 'finished',
    startedAt: '2026-08-19T15:49:00+00:00',
    finishedAt: '2026-08-19T15:49:04+00:00',
    source: 'google-flights',
    watching: ['LIM-SCL'],
    completed: 1,
    collected: 1,
    changed: 1,
    failed: 0,
    skipped: [],
    error: null,
    results: [
      {
        origin: 'LIM',
        destination: 'SCL',
        ok: true,
        changed: true,
        dates: 331,
        priced: 328,
        cheapest: 41.24,
        cheapestOn: '2026-08-23',
        currency: 'USD',
        requests: 2,
        errorCode: null,
        errorMessage: null,
      },
    ],
    ...overrides,
  };
}

/**
 * A POST that starts a pass and a GET that answers a scripted sequence.
 *
 * Told apart by method rather than by URL, because they are the same URL by
 * design: one document describes a pass whether or not it has finished.
 */
function stubHorizon(started: unknown, progress: unknown[] = []) {
  const posted: unknown[] = [];
  const polls: number[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        posted.push(JSON.parse(String(init?.body)));
        return Response.json(started);
      }
      const next = progress[Math.min(polls.length, progress.length - 1)];
      polls.push(1);
      return Response.json(next);
    }),
  );
  return { posted, polls };
}

describe('collecting a route’s booking horizon when the route is added', () => {
  it('asks for that city pair alone, in the currency the watch was added in', async () => {
    // A curve is keyed by city pair rather than by watch: it prices every month
    // at once, so a month would be a fact the request has no use for.
    const api = stubHorizon(horizonPass());
    const { result } = renderHook(() => useHorizonCollection(), { wrapper });

    act(() => result.current.collect(LIM_SCL));

    await waitFor(() => expect(api.posted).toHaveLength(1));
    expect(api.posted[0]).toEqual({ origin: 'LIM', destination: 'SCL', currency: 'USD' });
  });

  it('reports what came back, with the two figures a reader can act on', async () => {
    stubHorizon(horizonPass());
    const { result } = renderHook(() => useHorizonCollection(), { wrapper });

    act(() => result.current.collect(LIM_SCL));

    await waitFor(() => expect(result.current.reports.size).toBe(1));
    expect(result.current.reports.get(routeId(LIM_SCL))).toEqual({
      ok: true,
      text: 'Booking horizon collected: 328 of 331 departure dates priced in 2 requests.',
    });
    expect(result.current.collecting).toEqual([]);
  });

  it('leaves the route watched when the provider refuses, and says so', async () => {
    /*
     * The decision this test exists for. Adding a route is a write to the
     * reader's own document; this is a request to somebody else's server. A
     * route that failed to save because a fare lookup failed would let an
     * upstream veto a watchlist edit — and the reader would have no row left to
     * retry from. The hook has no way to unmake the add and must not grow one.
     */
    stubHorizon(
      horizonPass({
        results: [
          {
            origin: 'LIM',
            destination: 'SCL',
            ok: false,
            changed: false,
            dates: 0,
            priced: 0,
            cheapest: null,
            cheapestOn: null,
            currency: null,
            requests: 1,
            errorCode: 'upstream-error',
            errorMessage: 'the provider answered 429',
          },
        ],
        collected: 0,
        failed: 1,
      }),
    );
    const { result } = renderHook(() => useHorizonCollection(), { wrapper });

    act(() => result.current.collect(LIM_SCL));

    await waitFor(() => expect(result.current.reports.size).toBe(1));
    const report = result.current.reports.get(routeId(LIM_SCL))!;
    expect(report.ok).toBe(false);
    expect(report.text).toContain('upstream-error — the provider answered 429');
    expect(report.text).toContain('the chart says the horizon is not collected yet');
  });

  it('says the call itself never landed, where that is what happened', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('Failed to fetch');
      }),
    );
    const { result } = renderHook(() => useHorizonCollection(), { wrapper });

    act(() => result.current.collect(LIM_SCL));

    await waitFor(() => expect(result.current.reports.size).toBe(1));
    expect(result.current.reports.get(routeId(LIM_SCL))!.text).toContain(
      'The call failed: Failed to fetch',
    );
    expect(result.current.collecting).toEqual([]);
  });

  it('watches a pass that is still running until it stops', async () => {
    const api = stubHorizon(horizonPass({ state: 'running', finishedAt: null, results: [] }), [
      horizonPass({ state: 'running', finishedAt: null, results: [] }),
      horizonPass(),
    ]);
    const { result } = renderHook(() => useHorizonCollection(), { wrapper });

    act(() => result.current.collect(LIM_SCL));

    await waitFor(() => expect(result.current.reports.size).toBe(1));
    expect(result.current.reports.get(routeId(LIM_SCL))!.text).toContain(
      'Collecting the booking horizon for LIM → SCL',
    );

    await waitFor(
      () =>
        expect(result.current.reports.get(routeId(LIM_SCL))!.text).toContain(
          'Booking horizon collected',
        ),
      { timeout: 10_000 },
    );
    expect(api.polls.length).toBeGreaterThanOrEqual(2);
  }, 15_000);

  it('says nothing was spent where the pair already had a curve collected today', async () => {
    // Not-due is the ordinary way for this to end on a route being re-added,
    // and spending two requests to rewrite a curve is what the cadence refuses.
    stubHorizon(
      horizonPass({ results: [], collected: 0, skipped: [{ what: 'LIM-SCL', reason: 'not-due' }] }),
    );
    const { result } = renderHook(() => useHorizonCollection(), { wrapper });

    act(() => result.current.collect(LIM_SCL));

    await waitFor(() => expect(result.current.reports.size).toBe(1));
    const report = result.current.reports.get(routeId(LIM_SCL))!;
    expect(report.ok).toBe(true);
    expect(report.text).toContain('not collected again — not-due');
  });

  it('does not report somebody else’s pass as its own', async () => {
    // The server keeps one slot, so a press arriving while a pass runs is
    // answered with that pass. A row that read it as its own would be the
    // quietest lie this control could tell.
    stubHorizon(horizonPass({ watching: ['ARI-SCL'], results: [] }));
    const { result } = renderHook(() => useHorizonCollection(), { wrapper });

    act(() => result.current.collect(LIM_SCL));

    await waitFor(() => expect(result.current.reports.size).toBe(1));
    const report = result.current.reports.get(routeId(LIM_SCL))!;
    expect(report.ok).toBe(false);
    expect(report.text).toContain('ARI-SCL is already running');
  });

  it('fires once for two adds dispatched in the same tick', async () => {
    // React batches synchronous calls, so the state guard alone would let both
    // through; the ref is the synchronous half.
    const api = stubHorizon(horizonPass());
    const { result } = renderHook(() => useHorizonCollection(), { wrapper });

    act(() => {
      result.current.collect(LIM_SCL);
      result.current.collect(LIM_SCL);
    });

    await waitFor(() => expect(result.current.reports.size).toBe(1));
    expect(api.posted).toHaveLength(1);
  });

  it('drops a row’s report when the row itself goes', async () => {
    stubHorizon(horizonPass());
    const { result } = renderHook(() => useHorizonCollection(), { wrapper });

    act(() => result.current.collect(LIM_SCL));
    await waitFor(() => expect(result.current.reports.size).toBe(1));

    act(() => result.current.forget(routeId(LIM_SCL)));
    expect(result.current.reports.size).toBe(0);
  });
});
