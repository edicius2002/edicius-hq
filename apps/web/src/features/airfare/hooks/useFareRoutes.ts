import {
  addRoute,
  editRoute,
  EMPTY_FARE_ROUTES,
  FARE_ROUTES_KEY,
  normalizeFareRoutes,
  removeRoute,
  reorderRoutes,
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
 *
 * It took a `today` and no longer does. The date was here for one derived
 * value, `collectable`, which existed for the page-wide collect button and for
 * nothing else; with the button gone the parameter was a clock this hook asked
 * for and never read. What survives the button is the *rule*, as `hasDeparted`
 * in `data/fareRoutes` — asked by the one row that draws the answer, which is
 * also the only place that ever needed today's date to say it.
 */
export function useFareRoutes() {
  const store = useStoredDocument<FareRoutes>({
    key: FARE_ROUTES_KEY,
    normalize: normalizeFareRoutes,
    placeholder: EMPTY_FARE_ROUTES,
  });

  const document = store.data;

  return {
    routes: document.routes,
    isFetching: store.isFetching,
    isError: store.isError,
    saveState: store.saveState,
    retrySave: store.retrySave,

    add: (route: FareRoute) => store.edit((current) => addRoute(current, route)),
    remove: (id: string) => store.edit((current) => removeRoute(current, id)),
    move: (from: string, to: string) => store.edit((current) => reorderRoutes(current, from, to)),
    // The fourth transition is back, and it is not the focus returning —
    // `a-watch-is-a-pair-and-its-months`. `focus` went in 12.260 because it
    // wrote a *reading* into a stored document; this one writes what gets
    // collected. The rule it supersedes ("add, remove and reorder are the whole
    // of what can happen to a watch") was a consequence of the month being part
    // of the identity, and stopped holding when the identity became the pair.
    // Named `update` rather than `edit` because `useStoredDocument` owns `edit`
    // and `replace`, and shadowing either would make four verbs read as three.
    update: (id: string, next: FareRoute) => store.edit((current) => editRoute(current, id, next)),
    idOf: routeId,
  };
}
