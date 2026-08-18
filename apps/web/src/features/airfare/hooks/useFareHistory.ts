import { useQuery } from '@tanstack/react-query';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { fetchFareHistory, type FareHistoryResponse } from '@/shared/api/fares';

/**
 * The archive for one watched departure: our observations, the provider's own
 * daily history behind them, and whether the collector has been looking.
 *
 * All three arrive together because they answer one question between them —
 * what has this cost, what does it usually cost, and can this series be
 * trusted — and because splitting them would be three requests for one page.
 *
 * No `refetchInterval`. The archive changes when a collection pass finds
 * something, and a pass that finds nothing writes nothing; polling here would
 * be requests spent watching a file that is deliberately not moving. The page
 * invalidates this query after a manual collection instead.
 */
export function useFareHistory(route: FareRoute | null) {
  return useQuery<FareHistoryResponse>({
    queryKey: ['fares', 'history', route?.origin, route?.destination, route?.flightDate],
    queryFn: ({ signal }) =>
      fetchFareHistory(route!.origin, route!.destination, {
        flightDate: route!.flightDate,
        signal,
      }),
    enabled: route !== null,
  });
}
