import { useMemo } from 'react';

import {
  addRoute,
  collectableRoutes,
  EMPTY_FARE_ROUTES,
  FARE_ROUTES_KEY,
  normalizeFareRoutes,
  removeRoute,
  reorderRoutes,
  routeId,
  setFocus,
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
    move: (from: string, to: string) => store.edit((current) => reorderRoutes(current, from, to)),
    /**
     * Point one watch at a day inside its month, or at none — 12.130.
     *
     * A separate transition from `add` rather than an argument to it: adding
     * is where a focus is *stated*, and this is where it is taken back, which
     * the detail panel offers because that is the panel a focus changes.
     */
    focus: (id: string, date: string | null) =>
      store.edit((current) => setFocus(current, id, date)),
    idOf: routeId,
  };
}
