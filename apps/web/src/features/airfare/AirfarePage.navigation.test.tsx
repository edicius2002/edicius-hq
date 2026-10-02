import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { FareMonthProjection, FareFlightPage } from './data/fareProjections';
import type { FareRoute } from './data/fareRoutes';
import { tableRows } from './lib/flightTable';
import type { FareSnapshot } from '@/shared/api/fares';
import { AirfarePage } from './AirfarePage';

const state = vi.hoisted(() => ({
  fetchPage: vi.fn(),
  fetchMonth: vi.fn(),
  mapRenders: 0,
  routes: [
    { origin: 'ARI', destination: 'SCL', months: ['2027-03', '2027-04'], currency: 'USD' },
  ] as FareRoute[],
  empty: [],
  airports: new Map(),
  retry: () => {},
  curve: {
    capturedAt: '2026-09-20T10:00:00Z',
    source: 'google-flights',
    currency: 'USD',
    fromDate: '2027-03-01',
    toDate: '2027-04-30',
    prices: [
      { departureDate: '2027-03-01', price: 100, observedAt: '2026-09-20T10:00:00Z' },
      { departureDate: '2027-04-01', price: 110, observedAt: '2026-09-20T10:00:00Z' },
    ],
  },
}));
vi.mock('./data/supabaseAirfare', () => ({
  fetchFareFlightPage: state.fetchPage,
  fetchFareMonthProjection: state.fetchMonth,
}));
vi.mock('./hooks/useFareRoutes', () => ({
  useFareRoutes: () => ({ routes: state.routes, saveState: 'saved', retrySave: state.retry }),
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
vi.mock('./hooks/useFareCalendar', () => ({
  useFareCalendar: () => ({ data: { horizon: state.curve }, isPending: false, error: null }),
}));
vi.mock('./hooks/useAirports', () => ({ useAirports: () => ({ data: state.airports }) }));
// Count the map boundary without loading globe geometry; navigation and queries are real.
vi.mock('./ui/RouteMap', () => ({
  RouteMap: () => {
    state.mapRenders += 1;
    return <div />;
  },
}));
vi.mock('./ui/RouteList', () => ({
  RouteList: ({
    onOpenMonth,
    activeMonth,
    routes,
  }: {
    onOpenMonth: (id: string, month: string) => void;
    activeMonth: string | null;
    routes: FareRoute[];
  }) => (
    <div aria-label="Watched routes">
      {routes[0].months.map((month) => (
        <button
          key={month}
          aria-current={activeMonth === month ? 'true' : undefined}
          onClick={() => onOpenMonth('ARI|SCL', month)}
        >
          {month === '2027-04' ? 'Open April' : month}
        </button>
      ))}
    </div>
  ),
}));

function board(month: string): FareSnapshot {
  return {
    origin: 'ARI',
    destination: 'SCL',
    flightDate: `${month}-01`,
    returnDate: null,
    capturedAt: '2026-09-20T10:00:00Z',
    currency: 'USD',
    source: 'google-flights',
    insights: null,
    offers: [
      {
        airline: 'JA',
        airlineName: 'JetSMART',
        flightNumber: '100',
        departureAt: `${month}-01T07:15`,
        arrivalAt: null,
        transfers: 0,
        durationMinutes: 80,
        price: 100,
        currency: 'USD',
      },
    ],
  };
}

function projection(month: string, latestBoards: FareSnapshot[] = []): FareMonthProjection {
  return {
    origin: 'ARI',
    destination: 'SCL',
    month,
    revision: '1',
    latestCapture: '2026-09-20T10:00:00Z',
    latestBoards,
    viaSequences: [],
    priceDays: latestBoards.length
      ? [{ key: '2026-09-20', label: '09-20', low: 100, high: 100, middle: 100, count: 1 }]
      : [],
    providerDays: [],
    unsoldDays: [],
    health: { lastCheckedAt: null, checks: 0, changes: 0, errors: 0 },
    pairReference: null,
  };
}
function flightPage(page = 1, month = '2027-03'): FareFlightPage {
  const rows = tableRows(
    [
      {
        origin: 'ARI',
        destination: 'SCL',
        flightDate: `${month}-01`,
        returnDate: null,
        capturedAt: '2026-09-20T10:00:00Z',
        currency: 'USD',
        source: 'google-flights',
        insights: null,
        offers: Array.from({ length: 20 }, (_, index) => ({
          airline: 'JA',
          airlineName: 'JetSMART',
          flightNumber: String(100 + index),
          departureAt: `${month}-01T07:15`,
          arrivalAt: null,
          transfers: 0,
          durationMinutes: 80,
          price: 100 + index,
          currency: 'USD',
        })),
      },
    ],
    'month',
  ).rows.slice((page - 1) * 10, page * 10);

  return {
    revision: '1',
    latestCapture: '2026-09-20T10:00:00Z',
    tracked: 20,
    inPeriod: 20,
    shown: 20,
    page,
    pageCount: 2,
    rows,
    facets: {
      airlines: [],
      price: { low: 90, high: 200 },
      bands: [],
      stops: [],
      durations: [],
      categories: [],
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <AirfarePage />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  state.routes = [
    { origin: 'ARI', destination: 'SCL', months: ['2027-03', '2027-04'], currency: 'USD' },
  ];
  state.curve.fromDate = '2027-03-01';
  state.curve.toDate = '2027-04-30';
  state.mapRenders = 0;
  state.fetchMonth
    .mockReset()
    .mockImplementation((_from, _to, month: string) => Promise.resolve(projection(month)));
  state.fetchPage.mockReset().mockResolvedValue(flightPage());
});

it('follows the next collected watched month into the selected tab and price history', async () => {
  state.fetchMonth.mockImplementation((_from, _to, month: string) =>
    Promise.resolve(projection(month, [board(month)])),
  );
  const client = renderPage();
  await waitFor(() => expect(state.fetchMonth).toHaveBeenCalledTimes(2));
  await act(async () =>
    Promise.all(
      state.fetchMonth.mock.results.map((result) => result.value as Promise<FareMonthProjection>),
    ),
  );
  // Resolved is not yet rendered: under a loaded suite the click could land
  // before April's board reached the page, which is the "not collected" case.
  await waitFor(() => expect(client.isFetching()).toBe(0));

  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Open April' })).toHaveAttribute(
      'aria-current',
      'true',
    ),
  );
  expect(
    await screen.findByRole('heading', { name: 'ARI → SCL · April 2027' }),
  ).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /Cheapest fare for/ })).toHaveAccessibleName(/April 2027/);
});

it('keeps the reading month when the next watched month has no saved board', async () => {
  state.fetchMonth.mockImplementation((_from, _to, month: string) =>
    Promise.resolve(projection(month, month === '2027-03' ? [board(month)] : [])),
  );
  renderPage();
  await waitFor(() => expect(state.fetchMonth).toHaveBeenCalledTimes(2));
  await act(async () =>
    Promise.all(
      state.fetchMonth.mock.results.map((result) => result.value as Promise<FareMonthProjection>),
    ),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.getByRole('button', { name: '2027-03' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('heading', { name: 'ARI → SCL · March 2027' })).toBeInTheDocument();
  expect(screen.getByRole('img', { name: /Cheapest fare for/ })).toHaveAccessibleName(/March 2027/);
});

it('does not select a watched month whose projection is still unavailable', async () => {
  const april = deferred<FareMonthProjection>();
  state.fetchMonth.mockImplementation((_from, _to, month: string) =>
    month === '2027-04' ? april.promise : Promise.resolve(projection(month, [board(month)])),
  );
  renderPage();
  await waitFor(() => expect(state.fetchMonth).toHaveBeenCalledTimes(2));

  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.getByRole('button', { name: '2027-03' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('heading', { name: 'ARI → SCL · March 2027' })).toBeInTheDocument();
  await act(async () => april.resolve(projection('2027-04', [board('2027-04')])));
});

it('uses the start of a week to choose its month when changing granularity', async () => {
  state.fetchMonth.mockImplementation((_from, _to, month: string) =>
    Promise.resolve(projection(month, [board(month)])),
  );
  renderPage();
  await waitFor(() => expect(state.fetchMonth).toHaveBeenCalledTimes(2));
  await act(async () =>
    Promise.all(
      state.fetchMonth.mock.results.map((result) => result.value as Promise<FareMonthProjection>),
    ),
  );

  fireEvent.click(screen.getByRole('button', { name: 'Open April' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Open April' })).toHaveAttribute(
      'aria-current',
      'true',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Week' }));

  // April 1 belongs to the week beginning March 29; the board on April 1
  // does not turn that week into an April reading.
  expect(screen.getByRole('button', { name: '2027-03' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('heading', { name: 'ARI → SCL · March 2027' })).toBeInTheDocument();
});

it('keeps the reading month when the next frame is not watched', async () => {
  state.routes = [{ ...state.routes[0], months: ['2027-03'] }];
  state.fetchMonth.mockImplementation((_from, _to, month: string) =>
    Promise.resolve(projection(month, [board(month)])),
  );
  renderPage();
  await screen.findByRole('table');

  fireEvent.click(screen.getByRole('button', { name: 'Next month' }));
  expect(screen.getByRole('button', { name: '2027-03' })).toHaveAttribute('aria-current', 'true');
  expect(screen.getByRole('heading', { name: 'ARI → SCL · March 2027' })).toBeInTheDocument();
});

it('keeps the table, filters, focus and pager while loading the next page', async () => {
  const pending = deferred<FareFlightPage>();
  state.fetchPage.mockResolvedValueOnce(flightPage()).mockReturnValueOnce(pending.promise);
  renderPage();
  const next = await screen.findByRole('button', { name: 'Next page' });
  const table = screen.getByRole('table');
  const filter = screen.getByRole('spinbutton', { name: 'Min price' });
  filter.focus();
  fireEvent.click(next);
  await waitFor(() => expect(state.fetchPage).toHaveBeenCalledTimes(2));
  expect(table).toBeInTheDocument();
  expect(filter).toHaveFocus();
  expect(next).toBeInTheDocument();
  expect(next).toBeDisabled();
  await act(async () => pending.resolve(flightPage(2)));
  expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
  expect(screen.getByRole('table')).toBe(table);
});

it('chart month navigation skips the unrelated map render', async () => {
  renderPage();
  await screen.findByRole('table');
  const before = state.mapRenders;
  const departure = screen.getByRole('img', { name: /What each departure date costs/ });
  const frame = departure.getAttribute('aria-label');
  fireEvent.click(screen.getByRole('button', { name: /next.*month|next period/i }));
  await waitFor(() => expect(departure.getAttribute('aria-label')).not.toBe(frame));
  expect(departure).toHaveAccessibleName(/01\/04\/2027/);
  expect(state.mapRenders).toBe(before);
});

it('keeps the displayed month and table until both replacement requests arrive', async () => {
  const month = deferred<FareMonthProjection>();
  const flights = deferred<FareFlightPage>();
  state.fetchMonth.mockImplementation((_from, _to, requested: string) =>
    requested === '2027-04' ? month.promise : Promise.resolve(projection(requested)),
  );
  state.fetchPage.mockResolvedValueOnce(flightPage()).mockReturnValueOnce(flights.promise);
  renderPage();
  const table = await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: 'Open April' }));
  expect(table).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'ARI → SCL · March 2027' })).toBeInTheDocument();
  await act(async () => month.resolve(projection('2027-04')));
  await waitFor(() => expect(state.fetchPage).toHaveBeenCalledTimes(2));
  expect(table).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: /Flights seen.*March 2027/ })).toBeInTheDocument();
  await act(async () => flights.resolve(flightPage(1, '2027-04')));
  expect(
    await screen.findByRole('heading', { name: /Flights seen.*April 2027/ }),
  ).toBeInTheDocument();
  expect(screen.getByRole('table')).toBe(table);
});

it('retains the last rows on a failed page request and retries in place', async () => {
  state.fetchPage
    .mockResolvedValueOnce(flightPage())
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(flightPage(2));
  renderPage();
  const table = await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load saved fares');
  expect(table).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: /retry/i }));
  expect(await screen.findByText('Page 2 of 2')).toBeInTheDocument();
  expect(screen.getByRole('table')).toBe(table);
});

it('keeps a price filter focused while newer requests supersede older ones', async () => {
  const slow = deferred<FareFlightPage>();
  const fast = deferred<FareFlightPage>();
  state.fetchPage
    .mockResolvedValueOnce(flightPage())
    .mockReturnValueOnce(slow.promise)
    .mockReturnValueOnce(fast.promise);
  renderPage();
  await screen.findByRole('table');
  const input = await screen.findByRole('spinbutton', { name: 'Min price' });
  input.focus();
  fireEvent.change(input, { target: { value: '105' } });
  await waitFor(() => expect(state.fetchPage).toHaveBeenCalledTimes(2));
  fireEvent.change(input, { target: { value: '110' } });
  await waitFor(() => expect(state.fetchPage).toHaveBeenCalledTimes(3));
  expect(input).toHaveFocus();
  const filtered = { ...flightPage(2), page: 1, pageCount: 1, shown: 10 };
  await act(async () => fast.resolve(filtered));
  await waitFor(() =>
    expect(
      screen.queryByRole('navigation', { name: 'Flight table pages' }),
    ).not.toBeInTheDocument(),
  );
  await act(async () => slow.resolve(flightPage()));
  expect(input).toHaveFocus();
  expect(input).toHaveValue(110);
  expect(screen.queryByRole('navigation', { name: 'Flight table pages' })).not.toBeInTheDocument();
});

it('keeps departure navigation usable after a replacement month fails', async () => {
  state.fetchMonth.mockImplementation((_from, _to, month: string) =>
    month === '2027-04' ? Promise.reject(new Error('offline')) : Promise.resolve(projection(month)),
  );
  renderPage();
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: 'Open April' }));
  await screen.findByRole('alert');
  const departure = screen.getByRole('img', { name: /What each departure date costs/ });
  const before = departure.getAttribute('aria-label');
  const arrows = screen
    .getAllByRole('button')
    .filter(
      (button) =>
        /previous month|next month/i.test(button.getAttribute('aria-label') ?? '') &&
        !button.hasAttribute('disabled'),
    );
  expect(arrows.length).toBeGreaterThan(0);
  fireEvent.click(arrows[0]);
  await waitFor(() => expect(departure.getAttribute('aria-label')).not.toBe(before));
});

it('distinguishes unread departure months from confirmed empty boards', async () => {
  const april = deferred<FareMonthProjection>();
  state.fetchMonth.mockImplementation((_from, _to, month: string) =>
    month === '2027-04' ? april.promise : Promise.resolve(projection(month)),
  );
  renderPage();
  await screen.findByRole('table');
  fireEvent.click(screen.getByRole('button', { name: 'Open April' }));
  expect(screen.getByText(/Updating saved fares for April 2027/)).toBeInTheDocument();
  expect(
    screen.getByRole('img', { name: /Flight data not loaded for this frame/ }),
  ).toBeInTheDocument();
  expect(screen.queryAllByTestId('day-unanswered')).toHaveLength(0);
  await act(async () => april.resolve(projection('2027-04')));
  await waitFor(() =>
    expect(screen.getByRole('img', { name: /0 flights departing/ })).toBeInTheDocument(),
  );
  expect(screen.queryByText(/Updating saved fares for April 2027/)).not.toBeInTheDocument();
});
