import { useMemo } from 'react';

import {
  addRoute,
  collectableRoutes,
  EMPTY_FARE_ROUTES,
  FARE_ROUTES_KEY,
  normalizeFareRoutes,
  removeRoute,
  routeId,
  type FareRoute,
  type FareRoutes,
} from '@/features/airfare/data/fareRoutes';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

/**
 * The stored watchlist of routes, edited through the pure transitions.
 *
 * Every change goes through `store.edit`, which serialises writes and refuses
 * to write over a failed read. The rules live in `data/fareRoutes`, so nothing
 * here decides anything — the same division `useWatchlist` keeps.
 */
export function useFareRoutes(today: string) {
  const store = useStoredDocument<FareRoutes>({
    key: FARE_ROUTES_KEY,
    normalize: normalizeFareRoutes,
    placeholder: EMPTY_FARE_ROUTES,
  });

  const document = store.data;
  const collectable = useMemo(() => collectableRoutes(document, today), [document, today]);

  return {
    routes: document.routes,
    /** Those whose departure has not passed; the only ones worth asking about. */
    collectable,
    isFetching: store.isFetching,
    isError: store.isError,
    saveState: store.saveState,
    retrySave: store.retrySave,

    add: (route: FareRoute) => store.edit((current) => addRoute(current, route)),
    remove: (id: string) => store.edit((current) => removeRoute(current, id)),
    idOf: routeId,
  };
}
