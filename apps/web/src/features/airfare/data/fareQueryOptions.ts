import { queryOptions, type QueryClient } from '@tanstack/react-query';
import type { FareMonthProjection } from './fareProjections';
import { fetchFareMonthProjection, fetchFareFlightPage } from './supabaseAirfare';
import type { Filters, Sort } from '../lib/flightTable';
import { bucketBaseline, bucketSnapshots, unsoldPeriods } from '../lib/buckets';
import { latestPerDeparture } from '../lib/series';
import { fetchFareCalendar, fetchFareHistory } from '@/shared/api/fares';
import { archiveQueryOptions } from '../hooks/archiveQueryOptions';

function archiveRequested(): boolean {
  return (
    typeof location !== 'undefined' && new URLSearchParams(location.search).has('airfareArchive')
  );
}

async function readMonth(
  origin: string,
  destination: string,
  month: string,
  signal: AbortSignal,
): Promise<FareMonthProjection> {
  const projection = archiveRequested()
    ? null
    : await fetchFareMonthProjection(origin, destination, month, signal);
  if (projection !== null) return projection;

  // A new route has no projection until its first collection. The archive also
  // gives us a read path if the importer has not published a projection yet.
  const history = await fetchFareHistory(origin, destination, {
    departure: month,
    snapshotMonths: [month],
    signal,
  });
  return {
    origin,
    destination,
    month,
    revision: 'archive',
    latestCapture: history.snapshots.reduce<string | null>(
      (latest, snapshot) =>
        latest === null || snapshot.capturedAt > latest ? snapshot.capturedAt : latest,
      null,
    ),
    priceDays: history.priceDays
      ? history.priceDays.map((day) => ({ ...day, label: day.key.slice(5) }))
      : bucketSnapshots(history.snapshots, 'day'),
    providerDays: history.providerDays
      ? history.providerDays.map((day) => ({ ...day, label: day.key.slice(5) }))
      : bucketBaseline(history.baseline, 'day'),
    unsoldDays: history.unsoldDays
      ? history.unsoldDays.map((day) => ({ ...day, label: day.key.slice(5) }))
      : unsoldPeriods(history.snapshots, 'day'),
    latestBoards: latestPerDeparture(history.snapshots),
    currentBoards: [],
    departureChecks: [],
    availabilityKnown: false,
    viaSequences: [
      ...new Map(
        history.snapshots.flatMap((snapshot) =>
          snapshot.offers.flatMap((offer) => {
            const via = offer.viaPoints ?? [];
            return via.length ? [[via.join('>'), via] as const] : [];
          }),
        ),
      ).values(),
    ],
    archiveSnapshots: history.snapshots,
    health: history.health,
    pairReference: history.pairReference,
    retention: history.retention ?? undefined,
  };
}

export function fareProjectionOptions(origin: string, destination: string, month: string) {
  return queryOptions({
    ...archiveQueryOptions,
    retry: false,
    queryKey: ['fares', 'projection', origin, destination, month],
    queryFn: ({ signal }) => readMonth(origin, destination, month, signal),
  });
}

export function fareCalendarOptions(origin: string, destination: string) {
  return queryOptions({
    ...archiveQueryOptions,
    queryKey: ['fares', 'calendar', origin, destination],
    queryFn: ({ signal }) => fetchFareCalendar(origin, destination, { signal }),
  });
}

export type FareFlightPageInput = {
  origin: string;
  destination: string;
  month: string;
  revision: string;
  from: string;
  to: string;
  departure: string;
  filters: Filters;
  sort: Sort;
  page: number;
};

export function fareFlightPageOptions(client: QueryClient, input: FareFlightPageInput) {
  const { origin, destination, month, revision, from, to, filters, sort, page, departure } = input;
  return queryOptions({
    ...archiveQueryOptions,
    retry: false,
    queryKey: [
      'fares',
      'flightPage',
      origin,
      destination,
      month,
      revision,
      from,
      to,
      filters,
      sort,
      page,
    ],
    queryFn: async ({ signal }) => {
      const result = await fetchFareFlightPage(
        origin,
        destination,
        month,
        from,
        to,
        filters,
        sort,
        page,
        signal,
      );
      signal.throwIfAborted();
      if (result !== null && result.revision !== revision) {
        await client.invalidateQueries({
          queryKey: ['fares', 'projection', origin, destination, month],
        });
        throw new Error('Saved fares changed while loading flights. Retry to refresh.');
      }
      return { data: result, departure };
    },
  });
}
