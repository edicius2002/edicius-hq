import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';

import { ProjectedFlightTable } from './ProjectedFlightTable';
import { tableRows } from '../lib/flightTable';

const { fetchPage } = vi.hoisted(() => ({ fetchPage: vi.fn() }));
vi.mock('@/features/airfare/data/supabaseAirfare', () => ({ fetchFareFlightPage: fetchPage }));

it('does not retain old-revision flights when the replacement revision fails', async () => {
  fetchPage
    .mockReset()
    .mockResolvedValueOnce({
      revision: '1',
      latestCapture: '2026-09-20T10:00:00Z',
      tracked: 1,
      inPeriod: 1,
      shown: 1,
      page: 1,
      pageCount: 1,
      rows: tableRows(
        [
          {
            origin: 'AQP',
            destination: 'LIM',
            flightDate: '2026-11-01',
            returnDate: null,
            capturedAt: '2026-09-20T10:00:00Z',
            source: 'google-flights',
            currency: 'USD',
            insights: null,
            offers: [
              {
                airline: 'LA',
                airlineName: 'LATAM',
                flightNumber: '2100',
                departureAt: '2026-11-01T07:00',
                arrivalAt: null,
                transfers: 0,
                durationMinutes: 80,
                price: 100,
                currency: 'USD',
              },
            ],
          },
        ],
        'day',
      ).rows,
      facets: { airlines: [], price: null, bands: [], stops: [], durations: [], categories: [] },
    })
    .mockRejectedValue(new Error('offline'));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = (revision: string) => (
    <QueryClientProvider client={client}>
      <ProjectedFlightTable
        route={{ origin: 'AQP', destination: 'LIM', months: ['2026-11'], currency: 'USD' }}
        month="2026-11"
        revision={revision}
        latestCapture="2026-09-20T10:00:00Z"
        granularity="day"
        departure="November 2026"
        leg={null}
      />
    </QueryClientProvider>
  );
  const { rerender, unmount } = render(view('1'));
  expect(await screen.findByText('LA 2100')).toBeInTheDocument();
  rerender(view('2'));
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(screen.queryByText('LA 2100')).not.toBeInTheDocument();
  unmount();
  client.clear();
});

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

it('shows table skeleton rows during the initial request and a later filter request', async () => {
  fetchPage.mockReset();
  let settlePage: (value: unknown) => void = () => {};
  fetchPage.mockImplementation(
    () =>
      new Promise((resolve) => {
        settlePage = resolve;
      }),
  );
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
  expect(screen.getAllByTestId('flight-skeleton-row')).toHaveLength(10);
  expect(document.querySelectorAll('thead th')).toHaveLength(7);
  expect(screen.queryByRole('table')).not.toBeInTheDocument();
  await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(1));
  settlePage({
    revision: '1',
    latestCapture: '2026-09-20T10:00:00Z',
    tracked: 0,
    inPeriod: 0,
    shown: 0,
    page: 1,
    pageCount: 1,
    rows: [],
    facets: { airlines: [], price: null, bands: [], stops: [], durations: [], categories: [] },
  });
  await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument());
  expect(screen.getAllByTestId('flight-skeleton-row')).toHaveLength(10);
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Min price' }), {
    target: { value: '100' },
  });
  await waitFor(() => expect(fetchPage).toHaveBeenCalledTimes(2));
  expect(screen.getAllByTestId('flight-skeleton-row')).toHaveLength(10);
  expect(screen.queryByText('No itineraries observed yet.')).not.toBeInTheDocument();
});
