import { useCallback, useMemo } from 'react';

import {
  EMPTY_PORTFOLIO,
  PORTFOLIO_KEY,
  normalizePortfolio,
  reorderPositions,
  removePosition,
  setPosition,
  symbolsOf,
  type Portfolio,
} from '@/features/investing/data/portfolio';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

/**
 * The stored portfolio, edited through the same pure transitions the tests use.
 *
 * Writes go through the storage facade, so they stay serialised and are refused
 * after a failed read. The rules live in `data/portfolio`; nothing here decides
 * anything.
 */
export function usePortfolio() {
  const store = useStoredDocument<Portfolio>({
    key: PORTFOLIO_KEY,
    normalize: normalizePortfolio,
    placeholder: EMPTY_PORTFOLIO,
  });

  const portfolio = store.data;
  const symbols = useMemo(() => symbolsOf(portfolio), [portfolio]);

  const set = useCallback(
    (symbol: string, quantity: number, averageCost: number) =>
      store.edit((current) => setPosition(current, symbol, quantity, averageCost)),
    [store],
  );

  const remove = useCallback(
    (symbol: string) => store.edit((current) => removePosition(current, symbol)),
    [store],
  );

  const move = useCallback(
    (from: string, to: string) => store.edit((current) => reorderPositions(current, from, to)),
    [store],
  );

  return {
    portfolio,
    symbols,
    isFetching: store.isFetching,
    isError: store.isError,
    set,
    remove,
    move,
  };
}
