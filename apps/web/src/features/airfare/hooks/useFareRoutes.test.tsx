import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { useFareRoutes } from '@/features/airfare/hooks/useFareRoutes';
import { stubKvStore } from '@/test/kvStore';
import { queryWrapper } from '@/test/queryWrapper';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LIM_SCL: FareRoute = {
  origin: 'LIM',
  destination: 'SCL',
  months: ['2026-10'],
  currency: 'USD',
};

const wrapper = queryWrapper();

const stubRoutes = (initial: unknown) => stubKvStore({ key: 'airfare-routes', initial });

describe('useFareRoutes storage sync', () => {
  it('hydrates stored routes and persists an add', async () => {
    const api = stubRoutes({ version: 1, routes: [] });
    const { result } = renderHook(() => useFareRoutes(), { wrapper });

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
    const { result } = renderHook(() => useFareRoutes(), { wrapper });

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
    const { result } = renderHook(() => useFareRoutes(), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.routes).toEqual([]);
  });

  it('loads a stored route that carries a focus date as simply its month', async () => {
    /*
     * The migration, through the whole path the page uses rather than through
     * the normalizer alone — 12.261. This is the owner's own watchlist: one
     * route, `LIM→SCL 2027-03`, stored with `focusDate: '2027-03-09'` while a
     * watch could name a departure.
     *
     * Two things have to be true and only one of them is the normalizer's. The
     * route must load as its month with the day gone, and the day must not
     * come back on the first save: a `focusDate` that survived the read-then-
     * write cycle would be written to disk again and read again forever. The
     * `pagehide` flush is what exposes the second, so it is here.
     */
    const api = stubRoutes({
      version: 1,
      routes: [
        {
          origin: 'LIM',
          destination: 'SCL',
          month: '2027-03',
          focusDate: '2027-03-09',
          currency: 'USD',
        },
      ],
    });
    const { result } = renderHook(() => useFareRoutes(), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.routes).toEqual([
      { origin: 'LIM', destination: 'SCL', months: ['2027-03'], currency: 'USD' },
    ]);
    expect(Object.keys(result.current.routes[0])).not.toContain('focusDate');

    // An unrelated edit, so the document is written back at least once.
    await act(async () => {
      await result.current.add({ ...LIM_SCL, destination: 'MAD' });
    });
    window.dispatchEvent(new Event('pagehide'));

    await waitFor(() => expect(api.stored).not.toBeNull());
    const [stored] = (api.stored as { routes: Record<string, unknown>[] }).routes;
    expect(stored).toEqual({
      origin: 'LIM',
      destination: 'SCL',
      months: ['2027-03'],
      currency: 'USD',
    });
    expect(Object.keys(stored)).not.toContain('focusDate');
    // The same argument, one migration later: a dead key written back is a
    // dead key read forever, and `month` is now one.
    expect(Object.keys(stored)).not.toContain('month');
  });

  it('treats a missing document as an empty watchlist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(null, { status: 404 })),
    );
    const { result } = renderHook(() => useFareRoutes(), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.routes).toEqual([]);
    expect(result.current.isError).toBe(false);
  });
});
