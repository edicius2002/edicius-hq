import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { useFareHistory } from '@/features/airfare/hooks/useFareHistory';
import type { FareHistoryResponse } from '@/shared/api/fares';
import { queryWrapper, sharedQueryWrapper } from '@/test/queryWrapper';

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

const EMPTY: FareHistoryResponse = {
  origin: 'LIM',
  destination: 'MAD',
  snapshots: [],
  baseline: [],
  health: { lastCheckedAt: null, checks: 0, changes: 0, errors: 0 },
  airports: [],
  pairReference: null,
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

const wrapper = queryWrapper();

describe('useFareHistory', () => {
  it('does not replace the current route with an older, slower response', async () => {
    let finishFirst!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              finishFirst = resolve;
            }),
        )
        .mockImplementationOnce(() =>
          Promise.resolve(Response.json({ ...EMPTY, destination: 'SCL' })),
        ),
    );
    const shared = sharedQueryWrapper();
    const { result, rerender } = renderHook(({ route }) => useFareHistory(route, '2027-03'), {
      wrapper: shared,
      initialProps: { route: LIM_MAD },
    });
    rerender({ route: { ...LIM_MAD, destination: 'SCL' } });
    await waitFor(() => expect(result.current.data?.destination).toBe('SCL'));
    await act(async () => {
      finishFirst(Response.json(EMPTY));
    });
    expect(result.current.data?.destination).toBe('SCL');
    shared.client.clear();
  });

  it('waits until a reading month is selected', async () => {
    const urls = stubHistory();
    renderHook(() => useFareHistory(LIM_MAD, null), { wrapper });
    await Promise.resolve();
    expect(urls).toHaveLength(0);
  });

  it('asks for every watched snapshot month while retaining the active departure filter', async () => {
    const urls = stubHistory();
    const route = { ...LIM_MAD, months: ['2027-03', '2027-04'] };
    renderHook(() => useFareHistory(route, route.months[0]), { wrapper });

    await waitFor(() => expect(urls).toHaveLength(1));
    const params = new URL(urls[0], 'http://x').searchParams;
    expect(params.get('departure')).toBe('2027-03');
    expect(params.getAll('snapshotMonth')).toEqual(['2027-03', '2027-04']);
  });

  it('refetches when the watched month set changes while the active month does not', async () => {
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
    // `sharedQueryWrapper`, not the module's `wrapper`: one client across the
    // rerender, or the second month would find an empty cache whatever the
    // query key said and the test would pass for the wrong reason.
    const shared = sharedQueryWrapper();

    const { rerender } = renderHook(
      ({ route, month }: { route: FareRoute; month: string }) => useFareHistory(route, month),
      { wrapper: shared, initialProps: { route: LIM_MAD, month: '2027-03' } },
    );
    await waitFor(() => expect(urls).toHaveLength(1));

    rerender({ route: { ...LIM_MAD, months: ['2027-03', '2027-04'] }, month: '2027-03' });
    await waitFor(() => expect(urls).toHaveLength(2));
    const params = new URL(urls[1], 'http://x').searchParams;
    expect(params.get('departure')).toBe('2027-03');
    expect(params.getAll('snapshotMonth')).toEqual(['2027-03', '2027-04']);
  });
});
