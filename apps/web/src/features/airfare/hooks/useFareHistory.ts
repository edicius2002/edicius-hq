import { useQuery } from '@tanstack/react-query';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { fetchFareHistory, type FareSnapshot } from '@/shared/api/fares';

/**
 * The archived observations for one route.
 *
 * No `refetchInterval`. The series only changes when a collection pass runs,
 * which is once a day from a scheduled task — polling it would be requests
 * spent watching a file that is not moving.
 */
export function useFareHistory(route: FareRoute | null) {
  return useQuery<FareSnapshot[]>({
    queryKey: ['fares', 'history', route?.origin, route?.destination],
    queryFn: ({ signal }) =>
      fetchFareHistory(route!.origin, route!.destination, { signal }).then(
        (response) => response.snapshots,
      ),
    enabled: route !== null,
  });
}
