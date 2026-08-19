import { useQuery } from '@tanstack/react-query';

import { readingPrefix, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { fetchFareHistory, type FareHistoryResponse } from '@/shared/api/fares';

/**
 * The archive for one watched month — or for the single day inside it the
 * reader focused: our observations, the provider's own daily history behind
 * them, and whether the collector has been looking.
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
  // The month, or the focused day inside it — 12.131. Part of the key as well
  // as the request: the two answers differ, and a focus set on a month already
  // in the cache would otherwise be served the month's baseline and the
  // month's heartbeat counts under a heading naming one day.
  const departure = route ? readingPrefix(route) : null;

  return useQuery<FareHistoryResponse>({
    queryKey: ['fares', 'history', route?.origin, route?.destination, departure],
    queryFn: ({ signal }) =>
      fetchFareHistory(route!.origin, route!.destination, {
        // Both forms are legal `departure` prefixes, so the baseline and the
        // health counts come back for exactly the departures being read —
        // every day of the month, or the one day that was focused.
        departure: departure!,
        signal,
      }),
    enabled: route !== null,
  });
}
