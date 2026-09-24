import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { ProjectedFlightTable } from './ProjectedFlightTable';

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock('@/features/airfare/data/supabaseAirfare', () => ({ fetchFareFlightPage: fetchPage }));

it('requests one server page for the latest observation period and refetches on a filter', async () => {
  fetchPage.mockResolvedValue({
    revision: '1',
    latestCapture: '2026-09-20T10:00:00Z',
    tracked: 2,
    inPeriod: 2,
    shown: 0,
    page: 1,
    pageCount: 1,
    rows: [],
    facets: {
      airlines: [],
      price: { low: 90, high: 200 },
      bands: [],
      stops: [],
      durations: [],
      categories: [],
    },
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ProjectedFlightTable
        route={{ origin: 'AQP', destination: 'LIM', months: ['2026-11'], currency: 'USD' }}
        month="2026-11"
        revision="1"
        latestCapture="2026-09-20T10:00:00Z"
        granularity="day"
        departure="November 2026"
        leg={null}
      />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
  expect(fetchPage.mock.calls[0].slice(0, 5)).toEqual([
    'AQP',
    'LIM',
    '2026-11',
    '2026-09-20',
    '2026-09-20',
  ]);
  fireEvent.change(await screen.findByRole('spinbutton', { name: 'Min price' }), {
    target: { value: '100' },
  });
  await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
  expect(fetchPage.mock.calls[1][5].minPrice).toBe(100);
});
