import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { afterEach, expect, it, vi } from 'vitest';
import {
  fareCalendarOptions,
  fareProjectionOptions,
  fareFlightPageOptions,
} from './fareQueryOptions';
import { DEFAULT_SORT, NO_FILTERS } from '../lib/flightTable';

const remote = vi.hoisted(() => ({
  month: vi.fn(),
  history: vi.fn(),
  calendar: vi.fn(),
  page: vi.fn(),
}));
vi.mock('./supabaseAirfare', () => ({
  fetchFareMonthProjection: remote.month,
  fetchFareFlightPage: remote.page,
}));
vi.mock('@/shared/api/fares', () => ({
  fetchFareHistory: remote.history,
  fetchFareCalendar: remote.calendar,
}));
afterEach(() => vi.resetAllMocks());

const pageInput = {
  origin: 'AQP',
  destination: 'LIM',
  month: '2027-01',
  revision: 'r1',
  from: '2026-11-01',
  to: '2026-11-30',
  departure: 'January 2027',
  filters: NO_FILTERS,
  sort: DEFAULT_SORT,
  page: 1,
};

it('reuses the prepared flight page and its label, with independent page, filter and period keys', async () => {
  const client = new QueryClient();
  remote.page.mockResolvedValue({ revision: 'r1', rows: [] });
  const options = fareFlightPageOptions(client, pageInput);
  await client.fetchQuery(options);
  const observer = new QueryObserver(client, options);
  const stop = observer.subscribe(() => {});
  expect(observer.getCurrentResult().data).toEqual({
    data: { revision: 'r1', rows: [] },
    departure: 'January 2027',
  });
  expect(remote.page).toHaveBeenCalledTimes(1);
  for (const changed of [
    { page: 2 },
    { filters: { ...NO_FILTERS, minPrice: 50 } },
    { from: '2026-11-23' },
  ]) {
    await client.fetchQuery(fareFlightPageOptions(client, { ...pageInput, ...changed }));
  }
  expect(remote.page).toHaveBeenCalledTimes(4);
  stop();
  client.clear();
});

it('rejects incompatible flight revisions and invalidates the owning projection', async () => {
  const client = new QueryClient();
  const projection = fareProjectionOptions('AQP', 'LIM', '2027-01');
  client.setQueryData(projection.queryKey, {
    origin: 'AQP',
    destination: 'LIM',
    month: '2027-01',
    revision: 'r1',
    latestCapture: null,
    priceDays: [],
    providerDays: [],
    unsoldDays: [],
    latestBoards: [],
    currentBoards: [],
    departureChecks: [],
    availabilityKnown: true,
    viaSequences: [],
    pairReference: null,
    health: { lastCheckedAt: null, checks: 0, errors: 0, changes: 0 },
  });
  remote.page.mockResolvedValue({ revision: 'r2', rows: [] });
  await expect(client.fetchQuery(fareFlightPageOptions(client, pageInput))).rejects.toThrow(
    'Saved fares changed',
  );
  expect(client.getQueryState(projection.queryKey)?.isInvalidated).toBe(true);
  expect(client.getQueryData(fareFlightPageOptions(client, pageInput).queryKey)).toBeUndefined();
  client.clear();
});

it('shares a pending projection with its visible observer and reuses the fresh result', async () => {
  const client = new QueryClient();
  let finish!: (value: unknown) => void;
  remote.month.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const options = fareProjectionOptions('AQP', 'LIM', '2027-01');
  const pending = client.fetchQuery(options);
  const observer = new QueryObserver(client, options);
  const stop = observer.subscribe(() => {});
  const data = { month: '2027-01', priceDays: [] };
  finish(data);
  await pending;
  expect(observer.getCurrentResult().data).toEqual(data);
  await expect(client.fetchQuery(options)).resolves.toEqual(data);
  expect(remote.month).toHaveBeenCalledTimes(1);
  stop();
  client.clear();
});

it('keeps inverse routes and months separate while sharing a route calendar', async () => {
  const client = new QueryClient();
  remote.month.mockImplementation((origin, destination, month) => ({ origin, destination, month }));
  remote.calendar.mockResolvedValue({ horizon: null });
  const requests = [
    fareProjectionOptions('AQP', 'LIM', '2027-01'),
    fareProjectionOptions('LIM', 'AQP', '2027-01'),
    fareProjectionOptions('AQP', 'LIM', '2027-02'),
  ];
  for (const options of requests) {
    const data = await client.fetchQuery(options);
    expect(data).toMatchObject({
      origin: options.queryKey[2],
      destination: options.queryKey[3],
      month: options.queryKey[4],
    });
  }
  await client.fetchQuery(fareCalendarOptions('AQP', 'LIM'));
  await client.fetchQuery(fareCalendarOptions('AQP', 'LIM'));
  expect(remote.month).toHaveBeenCalledTimes(3);
  expect(remote.calendar).toHaveBeenCalledTimes(1);
  client.clear();
});

it('falls back only for a missing projection and retains departed numeric history', async () => {
  const client = new QueryClient();
  remote.month.mockResolvedValue(null);
  remote.history.mockResolvedValue({
    snapshots: [],
    baseline: [],
    health: {},
    pairReference: null,
    priceDays: [{ key: '2026-10-01', low: 10, high: 20, middle: 15, count: 2 }],
    retention: { cutoff: '2026-11-01', detailExpired: true },
  });
  const data = await client.fetchQuery(fareProjectionOptions('AQP', 'LIM', '2026-10'));
  expect(data.revision).toBe('archive');
  expect(data.priceDays[0]).toMatchObject({ label: '10-01', middle: 15 });
  expect(data.retention?.detailExpired).toBe(true);
  remote.month.mockRejectedValue(new Error('offline'));
  await expect(client.fetchQuery(fareProjectionOptions('AQP', 'LIM', '2026-12'))).rejects.toThrow(
    'offline',
  );
  expect(remote.history).toHaveBeenCalledTimes(1);
  client.clear();
});
