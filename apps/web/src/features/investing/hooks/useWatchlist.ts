import { useCallback, useMemo } from 'react';

import {
  addSymbol,
  EMPTY_WATCHLIST,
  normalizeWatchlist,
  removeSymbol,
  reorder,
  symbolsOf,
  withNames,
  WATCHLIST_KEY,
  type Watchlist,
} from '@/features/investing/data/watchlist';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

/**
 * The stored watchlist, edited through the same pure transitions the tests use.
 *
 * Every change goes through `store.edit`, which serialises writes and refuses
 * to write over a failed read — the two guarantees the storage facade exists
 * for. The rules themselves live in `data/watchlist`, so nothing here decides
 * anything.
 */
export function useWatchlist() {
  const store = useStoredDocument<Watchlist>({
    key: WATCHLIST_KEY,
    normalize: normalizeWatchlist,
    placeholder: EMPTY_WATCHLIST,
  });

  const list = store.data;
  const symbols = useMemo(() => symbolsOf(list), [list]);

  const learnNames = useCallback(
    (names: Map<string, string>) =>
      store.edit((current) => {
        const next = withNames(current, names);
        // Identity means nothing improved, and the facade skips the write.
        return next;
      }),
    [store],
  );

  return {
    list,
    symbols,
    isFetching: store.isFetching,
    isError: store.isError,

    add: (symbol: string, name?: string) => store.edit((c) => addSymbol(c, symbol, name)),
    remove: (symbol: string) => store.edit((c) => removeSymbol(c, symbol)),
    move: (from: string, to: string) => store.edit((c) => reorder(c, from, to)),
    /** Called when quotes arrive carrying better names than the stored ones. */
    learnNames,
  };
}
