import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { PropsWithChildren } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import { useFareProjections } from './useFareProjections';

const { fetchMonth } = vi.hoisted(() => ({ fetchMonth: vi.fn() }));
vi.mock('@/features/airfare/data/supabaseAirfare', () => ({
  fetchFareMonthProjection: fetchMonth,
}));

const route = {
  origin: 'AQP',
  destination: 'LIM',
  months: ['2026-11', '2026-12'],
  currency: 'USD',
};

afterEach(() => vi.clearAllMocks());

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
