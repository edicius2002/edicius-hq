import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { fetchFareFlightPage } from '@/features/airfare/data/supabaseAirfare';
import { bucketKey, periodBounds, type Granularity } from '@/features/airfare/lib/buckets';
import {
  DEFAULT_SORT,
  NO_FILTERS,
  type Filters,
  type Sort,
} from '@/features/airfare/lib/flightTable';
import { archiveQueryOptions } from '@/features/airfare/hooks/archiveQueryOptions';
import { FlightTable } from './FlightTable';
import { useRetainedData } from '@/shared/lib/useRetainedData';

type Criteria = { filters: Filters; sort: Sort; page: number };

export function ProjectedFlightTable({
  route,
  month,
  revision,
  latestCapture,
  granularity,
  departure,
  leg,
}: {
  route: FareRoute;
  month: string;
  revision: string;
  latestCapture: string | null;
  granularity: Granularity;
  departure: string;
  leg: { origin: string; destination: string; originCountry: string | null } | null;
}) {
  const queryClient = useQueryClient();
  const [criteria, setCriteria] = useState<Criteria>({
    filters: NO_FILTERS,
    sort: DEFAULT_SORT,
    page: 1,
  });
  const scope = `${route.origin}|${route.destination}`;
  const criteriaScope = `${scope}:${month}:${granularity}`;
  const [shownScope, setShownScope] = useState(criteriaScope);
  if (shownScope !== criteriaScope) {
    setShownScope(criteriaScope);
    setCriteria((current) => ({ ...current, page: 1 }));
  }

  const period =
    latestCapture === null
      ? null
      : {
          key: bucketKey(latestCapture, granularity),
          ...periodBounds(bucketKey(latestCapture, granularity), granularity),
        };
  const from = period?.from.slice(0, 10) ?? null;
  const to = period?.to.slice(0, 10) ?? null;
  const query = useQuery({
    ...archiveQueryOptions,
    retry: false,
    queryKey: [
      'fares',
      'flightPage',
      route.origin,
      route.destination,
      month,
      revision,
      from,
      to,
      criteria.filters,
      criteria.sort,
      criteria.page,
    ],
    queryFn: async ({ signal }) => {
      const result = await fetchFareFlightPage(
        route.origin,
        route.destination,
        month,
        from!,
        to!,
        criteria.filters,
        criteria.sort,
        criteria.page,
        signal,
      );
      if (result !== null && result.revision !== revision) {
        await queryClient.invalidateQueries({
          queryKey: ['fares', 'projection', route.origin, route.destination, month],
        });
        throw new Error('Saved fares changed while loading flights. Retry to refresh.');
      }
      // Retain the labels with their rows while a different month/period loads.
      return { data: result, period, departure };
    },
    enabled: from !== null && to !== null,
  });
  const shown = useRetainedData(scope, latestCapture === null ? null : query.data);
  const updating = latestCapture !== null && query.isFetching && query.data === undefined;

  return (
    <FlightTable
      snapshots={[]}
      granularity={granularity}
      departure={shown?.departure ?? departure}
      leg={leg}
      loading={latestCapture !== null && query.isPending && !shown}
      updating={updating}
      error={query.error}
      onRetry={() => void query.refetch()}
      remote={{
        period: shown?.period ?? period,
        data: shown?.data ?? null,
        criteria,
        onCriteriaChange: setCriteria,
      }}
    />
  );
}
