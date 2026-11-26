import { hashKey, isCancelledError, type QueryClient } from '@tanstack/react-query';

import { formatFlightMonth, openingMonth, routeId, type FareRoute } from './fareRoutes';
import {
  fareCalendarOptions,
  fareProjectionOptions,
  fareFlightPageOptions,
} from './fareQueryOptions';
import { bucketKey, periodBounds } from '../lib/buckets';
import { DEFAULT_SORT, NO_FILTERS } from '../lib/flightTable';
import { openingView } from '../hooks/useRouteView';

type Job = { key: string; priority: number; run: () => Promise<unknown> };

/** One bounded pass per page mount. Visible observers share this client's requests. */
export function createFarePreloader(client: QueryClient) {
  let routes: readonly FareRoute[] = [];
  let today = '';
  let selectedId: string | null = null;
  let running = 0;
  let disposed = false;
  const attempted = new Set<string>();

  function jobs(): Job[] {
    return routes
      .flatMap((route) => {
        const opening = openingMonth(route, today);
        const priority = (rank: number) => (routeId(route) === selectedId ? -1 : rank);
        const calendar = fareCalendarOptions(route.origin, route.destination);
        const projection = opening
          ? client.getQueryState(
              fareProjectionOptions(route.origin, route.destination, opening).queryKey,
            )
          : undefined;
        const data =
          projection?.status === 'success' && projection.fetchStatus === 'idle'
            ? projection.data
            : undefined;
        const flights: Job[] = [];
        if (data?.availabilityKnown && data.revision !== 'archive' && data.latestCapture) {
          const period = periodBounds(
            bucketKey(data.latestCapture, openingView(opening).granularity),
            openingView(opening).granularity,
          );
          const options = fareFlightPageOptions(client, {
            origin: route.origin,
            destination: route.destination,
            month: opening,
            revision: data.revision,
            from: period.from.slice(0, 10),
            to: period.to.slice(0, 10),
            departure: formatFlightMonth(opening),
            filters: NO_FILTERS,
            sort: DEFAULT_SORT,
            page: 1,
          });
          flights.push({
            key: hashKey(options.queryKey),
            priority: priority(1),
            run: () => client.fetchQuery(options),
          });
        }
        return [
          ...route.months.map((month) => {
            const options = fareProjectionOptions(route.origin, route.destination, month);
            return {
              key: hashKey(options.queryKey),
              priority: priority(month === opening ? 0 : 2),
              run: () => client.fetchQuery(options),
            };
          }),
          {
            key: hashKey(calendar.queryKey),
            priority: priority(0),
            run: () => client.fetchQuery(calendar),
          },
          ...flights,
        ];
      })
      .sort((a, b) => a.priority - b.priority);
  }

  function pump() {
    if (disposed) return;
    const pending = jobs().filter((job) => !attempted.has(job.key));
    while (running < 2 && pending.length > 0) {
      const job = pending.shift()!;
      attempted.add(job.key);
      running += 1;
      void job
        .run()
        .catch((error: unknown) => {
          // Removing the last visible observer can cancel a shared preload.
          // It is unfinished work, unlike a terminal read error. Reconcile it
          // against the current watchlist when the slot becomes available.
          if (isCancelledError(error)) attempted.delete(job.key);
          // An optional read must not block other routes or loop on a failed key.
          // Selecting it later uses the normal visible query's recovery policy.
        })
        .finally(() => {
          running -= 1;
          pump();
        });
    }
  }

  return {
    update(next: readonly FareRoute[], date: string, selected: string | null) {
      if (disposed) return;
      routes = next;
      today = date;
      selectedId = selected;
      pump();
    },
    dispose() {
      disposed = true;
      routes = [];
      // Do not cancel shared reads: a visible observer may now depend on one.
      // QueryProvider owns cancellation and cache removal on identity changes.
    },
  };
}
