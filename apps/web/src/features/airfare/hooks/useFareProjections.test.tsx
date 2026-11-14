import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { useFareProjections } from './useFareProjections';

const { fetchMonth, fetchHistory } = vi.hoisted(() => ({
  fetchMonth: vi.fn(),
  fetchHistory: vi.fn(),
}));
vi.mock('@/features/airfare/data/supabaseAirfare', () => ({
  fetchFareMonthProjection: fetchMonth,
}));
vi.mock('@/shared/api/fares', () => ({ fetchFareHistory: fetchHistory }));

const route = {
  origin: 'AQP',
  destination: 'LIM',
  months: ['2026-11', '2026-12'],
  currency: 'USD',
};

afterEach(() => vi.clearAllMocks());

it('uses retained daily buckets when a projection is absent for an expired month', async () => {
  fetchMonth.mockResolvedValue(null);
  fetchHistory.mockResolvedValue({
    snapshots: [],
    baseline: [],
    priceDays: [{ key: '2026-09-01', low: 10, high: 30, middle: 20, count: 2 }],
    providerDays: [],
    unsoldDays: [],
    retention: { cutoff: '2026-12-01', detailExpired: true },
    health: { lastCheckedAt: null, checks: 2, changes: 1, errors: 0 },
    pairReference: { value: 20, dates: 2 },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useFareProjections(route, '2026-11'), { wrapper });
  await waitFor(() => expect(result.current.primary.data?.retention?.detailExpired).toBe(true));
  expect(result.current.primary.data?.priceDays[0]).toEqual({
    key: '2026-09-01',
    label: '09-01',
    low: 10,
    high: 30,
    middle: 20,
    count: 2,
  });
  expect(result.current.primary.data?.latestBoards).toEqual([]);
});

it('fetches the open month before requesting secondary months', async () => {
  let resolvePrimary!: (value: unknown) => void;
  const primary = new Promise((resolve) => {
    resolvePrimary = resolve;
  });
  fetchMonth.mockImplementation((_origin: string, _destination: string, month: string) =>
    month === '2026-11' ? primary : Promise.resolve({ latestBoards: [] }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useFareProjections(route, '2026-11'), { wrapper });

  await waitFor(() => expect(fetchMonth).toHaveBeenCalledTimes(1));
  expect(fetchMonth.mock.calls[0][2]).toBe('2026-11');
  await act(async () => resolvePrimary({ latestBoards: [] }));
  await waitFor(() => expect(fetchMonth).toHaveBeenCalledTimes(2));
  expect(fetchMonth.mock.calls[1][2]).toBe('2026-12');
  expect(result.current.primary.data?.latestBoards).toEqual([]);
});

it('does not duplicate retained primary boards in secondary months during a switch', async () => {
  const board = { flightDate: '2026-11-01' };
  const november = { month: '2026-11', latestBoards: [board] };
  fetchMonth.mockImplementation((_origin: string, _destination: string, month: string) =>
    month === '2026-11' ? Promise.resolve(november) : new Promise(() => {}),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result, rerender } = renderHook(({ month }) => useFareProjections(route, month), {
    initialProps: { month: '2026-11' },
    wrapper,
  });
  await waitFor(() => expect(result.current.primary.data?.month).toBe('2026-11'));
  rerender({ month: '2026-12' });
  expect(result.current.primary.data?.latestBoards).toEqual([board]);
  expect(result.current.secondaryBoards).toEqual([]);
});

it('offers only months with collected history for price-chart navigation', async () => {
  fetchMonth.mockImplementation((_origin: string, _destination: string, month: string) =>
    Promise.resolve({
      month,
      latestCapture: month === '2026-11' ? '2026-10-01T12:00:00Z' : null,
      priceDays: [],
      providerDays: [],
      unsoldDays: [],
      departureChecks: [],
      latestBoards: [],
      currentBoards: [],
    }),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useFareProjections(route, '2026-11'), { wrapper });

  await waitFor(() => expect(fetchMonth).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.unavailableMonths).toEqual([]));
  expect(result.current.fetchedMonths).toEqual(['2026-11']);
});
