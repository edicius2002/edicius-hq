import { useQuery } from '@tanstack/react-query';

import { type FareRoute } from '@/features/airfare/data/fareRoutes';
import { fetchFareHistory, type FareHistoryResponse } from '@/shared/api/fares';
import { archiveQueryOptions } from './archiveQueryOptions';

/** A cache-safe identity even if a stale document loses its normal ordering. */
export function snapshotMonthSetKey(months: readonly string[]): string {
  return [...new Set(months)].sort().join(',');
}

/**
 * The archive for one watched month: our observations, the provider's own
 * daily history behind them, and whether the collector has been looking.
 *
 * All three arrive together because they answer one question between them —
 * what has this cost, what does it usually cost, and can this series be
 * trusted — and because splitting them would be three requests for one page.
 *
 * Local collections invalidate immediately; periodic reads also discover
 * scheduled collections and recover from failed requests without a reload.
 */
export function useFareHistory(route: FareRoute | null, month: string | null) {
  // The month being read, passed in rather than taken off the route — a watch
  // holds several and the chart draws one, so the route cannot answer this by
  // itself. It stays in the query key because two months of one pair have
  // distinct baseline and health scopes. The complete watched month set joins
  // that key and bounds snapshots, so an edited watch cannot reuse a cache
  // with too little chart data.
  const departure = route ? month : null;
  const snapshotMonths = route ? [...new Set(route.months)].sort() : [];
  const snapshotMonthSet = snapshotMonthSetKey(snapshotMonths);

  return useQuery<FareHistoryResponse>({
    ...archiveQueryOptions,
    // The reader already bounds revision restarts; outer retries multiply them.
    retry: false,
    queryKey: ['fares', 'history', route?.origin, route?.destination, departure, snapshotMonthSet],
    queryFn: ({ signal }) =>
      fetchFareHistory(route!.origin, route!.destination, {
        // `YYYY-MM` is a legal `departure` prefix — 12.112 — so the baseline
        // and the health counts come back for every day of the month.
        departure: departure!,
        snapshotMonths,
        signal,
      }),
    enabled: route !== null && month !== null,
  });
}
