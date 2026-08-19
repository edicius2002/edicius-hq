import { useQuery } from '@tanstack/react-query';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { fetchFareCalendar, type FareCalendarResponse } from '@/shared/api/fares';

/**
 * The whole booking horizon for one city pair, as last collected.
 *
 * Keyed by the pair alone and not by the watched month, because a curve is not
 * a month's: it prices every departure date out to the horizon at once, so two
 * watches on the same pair in different months read the same row and should
 * share the one cached copy rather than fetch it twice.
 *
 * Unconditional, exactly like `useFareHistory` beside it, and that was
 * measured rather than assumed. The first version took an `enabled` flag so
 * that a reader who never opened the chart never paid for the curve — but the
 * archive this page already fetches for every route it opens is **144 kB** on
 * the real ARI–SCL watch against the curve's **15 kB**, so gating the smaller
 * of the two would have bought under a tenth of what is already being spent.
 * What it cost was structural: `view` lives in `AnalysisPanel` since 12.170, so
 * only that component knows whether the chart is open, and putting the query
 * there turned a component that is handed all its data into one that needs a
 * `QueryClient` — ten of its tests broke on the provider alone. A saving that
 * small is not worth a component changing kind.
 *
 * No `refetchInterval`, for `useFareHistory`'s reason: a curve is written only
 * when something moved, and polling a file that is deliberately still is a
 * request spent watching nothing.
 */
export function useFareCalendar(route: FareRoute | null) {
  return useQuery<FareCalendarResponse>({
    queryKey: ['fares', 'calendar', route?.origin, route?.destination],
    queryFn: ({ signal }) => fetchFareCalendar(route!.origin, route!.destination, { signal }),
    enabled: route !== null,
  });
}
