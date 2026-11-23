import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createFarePreloader } from './farePreloader';
import { fareProjectionOptions } from './fareQueryOptions';
import type { FareRoute } from './fareRoutes';

const remote = vi.hoisted(() => ({
  month: vi.fn(),
  calendar: vi.fn(),
  history: vi.fn(),
  page: vi.fn(),
}));
vi.mock('./supabaseAirfare', () => ({
  fetchFareMonthProjection: remote.month,
  fetchFareFlightPage: remote.page,
}));
vi.mock('@/shared/api/fares', () => ({
  fetchFareCalendar: remote.calendar,
  fetchFareHistory: remote.history,
}));

const routes: FareRoute[] = [
  { origin: 'AQP', destination: 'LIM', months: ['2027-01', '2027-02'], currency: 'USD' },
  { origin: 'LIM', destination: 'AQP', months: ['2027-01', '2027-02'], currency: 'USD' },
];
const today = '2026-11-23';
let client: QueryClient;
let loader: ReturnType<typeof createFarePreloader>;
let started: string[];
let releases: (() => void)[];
let active: number;
let peak: number;

function hold(key: string, value: unknown): Promise<unknown> {
  started.push(key);
  active += 1;
  peak = Math.max(peak, active);
  return new Promise((resolve) =>
    releases.push(() => {
      active -= 1;
      resolve(value);
    }),
  );
}
beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  loader = createFarePreloader(client);
  started = [];
  releases = [];
  active = 0;
  peak = 0;
  remote.month.mockImplementation((origin, destination, month) =>
    hold(`${origin}-${destination}:${month}`, {
      origin,
      destination,
      month,
      revision: 'r1',
      availabilityKnown: false,
    }),
  );
  remote.calendar.mockImplementation((origin, destination) =>
    hold(`${origin}-${destination}:calendar`, { horizon: null }),
  );
  remote.page.mockImplementation((origin, destination) =>
    hold(`${origin}-${destination}:page`, { revision: 'r1', rows: [] }),
  );
});
afterEach(() => {
  loader.dispose();
  client.clear();
  vi.resetAllMocks();
});

async function finishWave(count: number) {
  const wave = releases.splice(0);
  wave.forEach((release) => release());
  await vi.waitFor(() => expect(started).toHaveLength(count));
}

it('starts without selection, bounds concurrent work and loads opening charts before other months', async () => {
  loader.update(routes, today, null);
  expect(started).toEqual(['AQP-LIM:2027-01', 'AQP-LIM:calendar']);
  loader.update(routes, today, null);
  await finishWave(4);
  expect(started.slice(2)).toEqual(['LIM-AQP:2027-01', 'LIM-AQP:calendar']);
  await finishWave(6);
  expect(started.slice(4)).toEqual(['AQP-LIM:2027-02', 'LIM-AQP:2027-02']);
  await finishWave(6);
  expect(peak).toBe(2);
  await vi.waitFor(() =>
    expect(client.getQueryData(['fares', 'projection', 'LIM', 'AQP', '2027-02'])).toMatchObject({
      month: '2027-02',
    }),
  );
});

it('shares an in-flight opening read with visible demand instead of downloading it twice', async () => {
  loader.update(routes, today, null);
  const visible = client.fetchQuery(fareProjectionOptions('AQP', 'LIM', '2027-01'));
  releases.shift()!();
  await expect(visible).resolves.toMatchObject({ month: '2027-01' });
  expect(started.filter((key) => key === 'AQP-LIM:2027-01')).toHaveLength(1);
});

it('promotes selected-route secondary months ahead of other routes', async () => {
  loader.update(routes, today, null);
  loader.update(routes, today, 'AQP|LIM');
  releases.shift()!();
  await vi.waitFor(() => expect(started[2]).toBe('AQP-LIM:2027-02'));
});

it('reconciles removed and added watches and never restarts work on reorder', async () => {
  loader.update([], today, null);
  expect(started).toEqual([]);
  loader.update(routes, today, null);
  const next = [{ ...routes[0], months: ['2027-01', '2027-03'] }];
  loader.update(next, today, null);
  await finishWave(3);
  expect(started[2]).toBe('AQP-LIM:2027-03');
  await finishWave(3);
  loader.update([...next].reverse(), today, null);
  expect(started).toHaveLength(3);
});

it('continues after failures without retrying forever and lets visible demand recover', async () => {
  remote.month.mockRejectedValueOnce(new Error('offline'));
  loader.update(routes, today, null);
  await vi.waitFor(() => expect(started).toHaveLength(2));
  expect(started).toEqual(['AQP-LIM:calendar', 'LIM-AQP:2027-01']);
  expect(client.getQueryState(['fares', 'projection', 'AQP', 'LIM', '2027-01'])?.status).toBe(
    'error',
  );
  expect(remote.history).not.toHaveBeenCalled();
  const visible = client.fetchQuery(fareProjectionOptions('AQP', 'LIM', '2027-01'));
  releases.pop()!();
  await expect(visible).resolves.toMatchObject({ month: '2027-01' });
});

it('dispose stops successors but preserves an already-shared visible request', async () => {
  loader.update(routes, today, null);
  const visible = client.fetchQuery(fareProjectionOptions('AQP', 'LIM', '2027-01'));
  loader.dispose();
  releases.splice(0).forEach((release) => release());
  await expect(visible).resolves.toMatchObject({ month: '2027-01' });
  loader.update(routes, today, 'AQP|LIM');
  expect(started).toHaveLength(2);
});

it('queues the default flight page after opening charts, before secondary months, in the same limit', async () => {
  remote.month.mockImplementation((origin, destination, month) =>
    hold(`${origin}-${destination}:${month}`, {
      origin,
      destination,
      month,
      revision: 'r1',
      availabilityKnown: true,
      latestCapture: '2026-11-23T12:00:00Z',
    }),
  );
  loader.update(routes, today, null);
  await finishWave(4);
  await finishWave(6);
  expect(started.slice(4)).toEqual(['AQP-LIM:page', 'LIM-AQP:page']);
  expect(remote.page.mock.calls[0].slice(2, 8)).toEqual([
    '2027-01',
    '2026-11-01',
    '2026-11-30',
    {
      minPrice: null,
      maxPrice: null,
      airline: null,
      band: null,
      stops: null,
      maxDuration: null,
      change: null,
    },
    { column: 'departs', direction: 'asc' },
    1,
  ]);
  await finishWave(8);
  expect(started.slice(6)).toEqual(['AQP-LIM:2027-02', 'LIM-AQP:2027-02']);
  expect(peak).toBe(2);
});

it.each([
  { revision: 'archive', availabilityKnown: true, latestCapture: '2026-11-23T12:00:00Z' },
  { revision: 'r1', availabilityKnown: false, latestCapture: '2026-11-23T12:00:00Z' },
  { revision: 'r1', availabilityKnown: true, latestCapture: null },
])('does not preload flights without compatible current detail: %o', async (detail) => {
  remote.month.mockResolvedValue(detail);
  remote.calendar.mockResolvedValue({ horizon: null });
  loader.update(routes, today, null);
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  expect(remote.page).not.toHaveBeenCalled();
});

it('a new pass reuses fresh entries and refreshes stale entries without losing their data', async () => {
  remote.month.mockImplementation(async (origin, destination, month) => ({
    origin,
    destination,
    month,
    availabilityKnown: false,
  }));
  remote.calendar.mockResolvedValue({ horizon: null });
  loader.update(routes, today, null);
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  loader.dispose();
  loader = createFarePreloader(client);
  loader.update(routes, today, null);
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  expect(remote.month).toHaveBeenCalledTimes(4);
  expect(remote.calendar).toHaveBeenCalledTimes(2);
  loader.dispose();
  const key = ['fares', 'projection', 'AQP', 'LIM', '2027-01'];
  const previous = client.getQueryData(key);
  client.setQueryData(key, previous, { updatedAt: Date.now() - 61_000 });
  let finish!: () => void;
  remote.month.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = () => resolve(previous);
      }),
  );
  loader = createFarePreloader(client);
  loader.update(routes, today, null);
  expect(client.getQueryData(key)).toEqual(previous);
  expect(remote.month).toHaveBeenCalledTimes(5);
  finish();
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
});

it('visible demand for another route starts immediately even when both preload slots are occupied', async () => {
  loader.update(routes, today, null);
  const visible = client.fetchQuery(fareProjectionOptions('LIM', 'AQP', '2027-02'));
  expect(started).toHaveLength(3);
  releases.pop()!();
  await expect(visible).resolves.toMatchObject({ origin: 'LIM', month: '2027-02' });
});

it('a missing projection falls back inside the same slot and preserves historical summaries', async () => {
  remote.month.mockResolvedValue(null);
  remote.history.mockImplementation((origin, destination, { departure }) =>
    hold(`${origin}-${destination}:${departure}`, {
      snapshots: [],
      baseline: [],
      health: {},
      pairReference: null,
      priceDays: [{ key: '2026-10-01', low: 10, high: 30, middle: 20, count: 2 }],
      retention: { cutoff: '2026-11-01', detailExpired: true },
    }),
  );
  loader.update([{ ...routes[0], months: ['2026-10'] }], today, null);
  await vi.waitFor(() => expect(started).toHaveLength(2));
  releases.splice(0).forEach((release) => release());
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  expect(peak).toBe(2);
  expect(client.getQueryData(['fares', 'projection', 'AQP', 'LIM', '2026-10'])).toMatchObject({
    revision: 'archive',
    retention: { detailExpired: true },
    priceDays: [{ middle: 20 }],
  });
  expect(remote.page).not.toHaveBeenCalled();
});
