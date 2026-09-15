import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFareCalendar } from './useFareCalendar';
import { useFareHistory } from './useFareHistory';
import { sharedQueryWrapper } from '@/test/queryWrapper';

const route = { origin: 'LIM', destination: 'MAD', months: ['2027-03'], currency: 'USD' };
const health = { lastCheckedAt: null, checks: 0, changes: 0, errors: 0 };
const empty = {
  origin: 'LIM',
  destination: 'MAD',
  snapshots: [],
  baseline: [],
  airports: [],
  horizon: null,
  health,
};
const saved = {
  ...empty,
  snapshots: [
    {
      capturedAt: '2026-09-11T12:00:00Z',
      source: 'archive',
      origin: 'LIM',
      destination: 'MAD',
      flightDate: '2027-03-01',
      returnDate: null,
      currency: 'USD',
      insights: null,
      offers: [
        {
          airline: 'IB',
          airlineName: 'Iberia',
          flightNumber: '6650',
          departureAt: '2027-03-01T12:00',
          arrivalAt: null,
          transfers: 0,
          durationMinutes: 700,
          price: 500,
          currency: 'USD',
        },
      ],
    },
  ],
  horizon: {
    capturedAt: '2026-09-11T12:00:00Z',
    source: 'archive',
    currency: 'USD',
    fromDate: '2027-03-01',
    toDate: '2027-03-01',
    prices: [{ departureDate: '2027-03-01', price: 500, observedAt: '2026-09-11T12:00:00Z' }],
  },
  health: { ...health, checks: 1 },
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe.each([
  ['history', () => useFareHistory(route, '2027-03')],
  ['calendar', () => useFareCalendar(route)],
] as const)('%s archive loading', (_name, useArchive) => {
  it('discovers data written outside this tab without a reload', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(empty)));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = sharedQueryWrapper();
    const { result } = renderHook(() => useArchive(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data?.health.checks).toBe(0);
    fetcher.mockImplementation(() => Promise.resolve(Response.json(saved)));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.data?.health.checks).toBe(1);
    expect(result.current.data).toEqual(saved);
    wrapper.client.clear();
  });

  it('recovers after an exhausted request failure without a reload', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockRejectedValue(new TypeError('Network unavailable'));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = sharedQueryWrapper();
    const { result } = renderHook(() => useArchive(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.isError).toBe(true);
    fetcher.mockImplementation(() => Promise.resolve(Response.json(saved)));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.isSuccess).toBe(true);
    expect(result.current.data).toEqual(saved);
    wrapper.client.clear();
  });

  it('reuses a recent response when reopening the route', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(empty)));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = sharedQueryWrapper();
    const first = renderHook(() => useArchive(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    first.unmount();
    await act(() => vi.advanceTimersByTimeAsync(35_000));
    const second = renderHook(() => useArchive(), { wrapper });
    expect(second.result.current.data).toBeDefined();
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(fetcher).toHaveBeenCalledTimes(1);
    wrapper.client.clear();
  });

  it('keeps saved fares visible when a background refresh fails', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(Response.json(saved)));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = sharedQueryWrapper();
    const { result } = renderHook(() => useArchive(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.data).toEqual(saved);
    fetcher.mockRejectedValue(new TypeError('Network unavailable'));
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toEqual(saved);
    wrapper.client.clear();
  });

  it.each([408, 429])('recovers automatically after temporary HTTP %s', async (status) => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockImplementation(() => Promise.resolve(Response.json({}, { status })));
    vi.stubGlobal('fetch', fetcher);
    const wrapper = sharedQueryWrapper();
    const { result } = renderHook(() => useArchive(), { wrapper });
    await act(() => vi.advanceTimersByTimeAsync(10));
    expect(result.current.isError).toBe(true);
    fetcher.mockImplementation(() => Promise.resolve(Response.json(saved)));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(result.current.isSuccess).toBe(true);
    wrapper.client.clear();
  });
});
