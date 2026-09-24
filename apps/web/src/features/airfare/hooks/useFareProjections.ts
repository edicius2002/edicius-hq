import { useQueries, useQuery } from '@tanstack/react-query';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import type { FareMonthProjection } from '@/features/airfare/data/fareProjections';
import { fetchFareMonthProjection } from '@/features/airfare/data/supabaseAirfare';
import { bucketBaseline, bucketSnapshots, unsoldPeriods } from '@/features/airfare/lib/buckets';
import { latestPerDeparture } from '@/features/airfare/lib/series';
import { fetchFareHistory } from '@/shared/api/fares';
import { archiveQueryOptions } from './archiveQueryOptions';

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
    priceDays: bucketSnapshots(history.snapshots, 'day'),
    providerDays: bucketBaseline(history.baseline, 'day'),
    unsoldDays: unsoldPeriods(history.snapshots, 'day'),
    latestBoards: latestPerDeparture(history.snapshots),
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
  };
}

export function useFareProjections(route: FareRoute | null, month: string | null) {
  const primary = useQuery({
    ...archiveQueryOptions,
    retry: false,
    queryKey: ['fares', 'projection', route?.origin, route?.destination, month],
    queryFn: ({ signal }) => readMonth(route!.origin, route!.destination, month!, signal),
    enabled: route !== null && month !== null,
  });

  // The selected month paints first; other watched months only supply departure
  // frames when they arrive and each remains cached under its own month key.
  const secondaryBoards = useQueries({
    queries:
      route?.months
        .filter((other) => other !== month)
        .map((other) => ({
          ...archiveQueryOptions,
          retry: false,
          queryKey: ['fares', 'projection', route.origin, route.destination, other],
          queryFn: ({ signal }: { signal: AbortSignal }) =>
            readMonth(route.origin, route.destination, other, signal),
          enabled: primary.data !== undefined,
        })) ?? [],
    combine: (results) => results.flatMap((result) => result.data?.latestBoards ?? []),
  });

  return { primary, secondaryBoards };
}
