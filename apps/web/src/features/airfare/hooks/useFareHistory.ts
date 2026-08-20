import { useQuery } from '@tanstack/react-query';

import { type FareRoute } from '@/features/airfare/data/fareRoutes';
import { fetchFareHistory, type FareHistoryResponse } from '@/shared/api/fares';

/**
 * The archive for one watched month: our observations, the provider's own
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
  // The month, and only the month — 12.260. This was `readingPrefix`, which
  // returned the focused day where a watch named one; a route names none now,
  // so the two answers it chose between are one. It stays in the query key
  // because two watches on the same pair in different months are two different
  // archives.
  const departure = route ? route.month : null;

  return useQuery<FareHistoryResponse>({
    queryKey: ['fares', 'history', route?.origin, route?.destination, departure],
    queryFn: ({ signal }) =>
      fetchFareHistory(route!.origin, route!.destination, {
        // `YYYY-MM` is a legal `departure` prefix — 12.112 — so the baseline
        // and the health counts come back for every day of the month.
        departure: departure!,
        signal,
      }),
    enabled: route !== null,
  });
}
