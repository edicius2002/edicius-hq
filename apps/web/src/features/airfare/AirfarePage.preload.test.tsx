import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AirfarePage } from './AirfarePage';
import type { FareMonthProjection } from './data/fareProjections';
import { tableRows } from './lib/flightTable';

const state = vi.hoisted(() => ({
  month: vi.fn(),
  calendar: vi.fn(),
  page: vi.fn(),
  empty: [],
  airports: new Map(),
  routes: [{ origin: 'AQP', destination: 'LIM', months: ['2027-01', '2027-02'], currency: 'USD' }],
}));
vi.mock('@/shared/auth/supabaseAuth', () => ({
  subscribeToAuth: (cb: (event: string, session: unknown) => void) => {
    cb('INITIAL_SESSION', { user: { id: 'owner' } });
    return () => {};
  },
}));
vi.mock('./data/supabaseAirfare', () => ({
  fetchFareMonthProjection: state.month,
  fetchFareFlightPage: state.page,
}));
vi.mock('@/shared/api/fares', () => ({ fetchFareCalendar: state.calendar }));
vi.mock('./hooks/useFareRoutes', () => ({
  useFareRoutes: () => ({ routes: state.routes, saveState: 'saved' }),
}));
vi.mock('./hooks/useRouteCollection', () => ({
  useRouteCollection: () => ({
    collecting: state.empty,
    notices: state.empty,
    progress: new Map(),
  }),
}));
vi.mock('./hooks/useHorizonCollection', () => ({
  useHorizonCollection: () => ({ collecting: state.empty }),
}));
vi.mock('./hooks/useAirports', () => ({ useAirports: () => ({ data: state.airports }) }));
vi.mock('./ui/RouteMap', () => ({ RouteMap: () => <div /> }));
vi.mock('./ui/RouteList', () => ({
  RouteList: ({
    onOpenMonth,
    selectedId,
  }: {
    onOpenMonth: (id: string, month: string) => void;
    selectedId: string | null;
  }) => (
    <button aria-pressed={selectedId !== null} onClick={() => onOpenMonth('AQP|LIM', '2027-01')}>
      Open AQP–LIM
    </button>
  ),
}));

function projection(month: string): FareMonthProjection {
  return {
    origin: 'AQP',
    destination: 'LIM',
    month,
    revision: 'r1',
    latestCapture: '2026-11-23T12:00:00Z',
    priceDays: [{ key: '2026-11-23', label: '11-23', low: 100, high: 120, middle: 110, count: 2 }],
    providerDays: [],
    unsoldDays: [],
    latestBoards: [],
    currentBoards: [],
    departureChecks: [],
    availabilityKnown: true,
    viaSequences: [],
    health: { lastCheckedAt: null, checks: 0, changes: 0, errors: 0 },
    pairReference: null,
  };
}
afterEach(() => vi.resetAllMocks());

it('prepares charts and flights before selection and renders them without another fresh read', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let finish!: () => void;
  state.month.mockImplementation((_origin, _destination, month) =>
    month === '2027-01'
      ? new Promise((resolve) => {
          finish = () => resolve(projection(month));
        })
      : Promise.resolve(projection(month)),
  );
  state.calendar.mockResolvedValue({
    horizon: {
      capturedAt: '2026-11-23T12:00:00Z',
      source: 'google-flights',
      currency: 'USD',
      fromDate: '2027-01-01',
      toDate: '2027-02-28',
      prices: [{ departureDate: '2027-01-01', price: 100, observedAt: '2026-11-23T12:00:00Z' }],
    },
  });
  state.page.mockResolvedValue({
    revision: 'r1',
    latestCapture: '2026-11-23T12:00:00Z',
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
          flightDate: '2027-01-01',
          returnDate: null,
          capturedAt: '2026-11-23T12:00:00Z',
          currency: 'USD',
          source: 'google-flights',
          insights: null,
          offers: [
            {
              airline: 'LA',
              airlineName: 'LATAM',
              flightNumber: '2100',
              departureAt: '2027-01-01T07:00',
              arrivalAt: null,
              transfers: 0,
              durationMinutes: 80,
              price: 100,
              currency: 'USD',
            },
          ],
        },
      ],
      'month',
    ).rows,
    facets: {
      airlines: [],
      price: { low: 100, high: 100 },
      bands: [],
      stops: [],
      durations: [],
      categories: [],
    },
  });
  const { unmount } = render(
    <QueryClientProvider client={client}>
      <AirfarePage />
    </QueryClientProvider>,
  );
  await waitFor(() => expect(state.month).toHaveBeenCalled());
  expect(screen.getByRole('button', { name: 'Open AQP–LIM' })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  expect(screen.queryByRole('img', { name: /Cheapest fare for/ })).not.toBeInTheDocument();
  await act(async () => finish());
  await waitFor(() =>
    expect(client.getQueryData(['fares', 'projection', 'AQP', 'LIM', '2027-02'])).toBeDefined(),
  );
  await waitFor(() => expect(client.isFetching()).toBe(0));
  fireEvent.click(screen.getByRole('button', { name: 'Open AQP–LIM' }));
  expect(
    screen.getByRole('img', { name: /Cheapest fare for.*1 day observed/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole('img', { name: /What each departure date costs for/ }),
  ).toBeInTheDocument();
  expect(state.month).toHaveBeenCalledTimes(2);
  expect(state.calendar).toHaveBeenCalledTimes(1);
  expect(screen.getByText('LA 2100')).toBeInTheDocument();
  expect(state.page).toHaveBeenCalledTimes(1);
  unmount();
  client.clear();
});
