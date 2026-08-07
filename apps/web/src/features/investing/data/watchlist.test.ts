import { describe, expect, it } from 'vitest';

import {
  addSymbol,
  EMPTY_WATCHLIST,
  normalizeWatchlist,
  removeSymbol,
  reorder,
  symbolsOf,
  withNames,
  type Watchlist,
} from '@/features/investing/data/watchlist';

function listOf(...symbols: string[]): Watchlist {
  return { version: 1, entries: symbols.map((symbol) => ({ symbol, name: symbol })) };
}

describe('normalizeWatchlist', () => {
  it('reads back what was stored', () => {
    const stored = { version: 1, entries: [{ symbol: 'AAPL', name: 'Apple Inc.' }] };
    expect(normalizeWatchlist(stored).entries).toEqual([{ symbol: 'AAPL', name: 'Apple Inc.' }]);
  });

  it('upper-cases and trims, so one spelling is one row', () => {
    const list = normalizeWatchlist({ entries: [{ symbol: ' aapl ' }] });
    expect(list.entries[0].symbol).toBe('AAPL');
  });

  it('drops a duplicate rather than polling and flashing it twice', () => {
    const list = normalizeWatchlist({ entries: [{ symbol: 'AAPL' }, { symbol: 'aapl' }] });
    expect(symbolsOf(list)).toEqual(['AAPL']);
  });

  it('falls back to the symbol when there is no name', () => {
    expect(normalizeWatchlist({ entries: [{ symbol: 'MSFT' }] }).entries[0].name).toBe('MSFT');
  });

  it('gives an empty list for anything unusable, rather than throwing', () => {
    for (const value of [null, undefined, 42, 'text', {}, { entries: 'no' }]) {
      expect(normalizeWatchlist(value)).toEqual(EMPTY_WATCHLIST);
    }
  });

  it('skips entries that are not entries', () => {
    const list = normalizeWatchlist({ entries: [null, { symbol: '' }, 7, { symbol: 'OK' }] });
    expect(symbolsOf(list)).toEqual(['OK']);
  });
});

describe('addSymbol', () => {
  it('appends to the end', () => {
    expect(symbolsOf(addSymbol(listOf('AAPL'), 'MSFT'))).toEqual(['AAPL', 'MSFT']);
  });

  it('keeps the name the provider gave it', () => {
    const list = addSymbol(EMPTY_WATCHLIST, 'AAPL', 'Apple Inc.');
    expect(list.entries[0].name).toBe('Apple Inc.');
  });

  it('leaves a symbol already there exactly where it is', () => {
    const before = listOf('AAPL', 'MSFT');
    const after = addSymbol(before, 'aapl');
    // Adding one you already follow is a no-op, not a move to the end.
    expect(after).toBe(before);
  });

  it('ignores an empty symbol', () => {
    expect(addSymbol(EMPTY_WATCHLIST, '   ')).toBe(EMPTY_WATCHLIST);
  });
});

describe('removeSymbol', () => {
  it('takes the row out', () => {
    expect(symbolsOf(removeSymbol(listOf('AAPL', 'MSFT'), 'AAPL'))).toEqual(['MSFT']);
  });

  it('hands back the same list when there was nothing to remove', () => {
    const before = listOf('AAPL');
    expect(removeSymbol(before, 'NVDA')).toBe(before);
  });
});

describe('reorder', () => {
  it('moves a row to where the target sits', () => {
    expect(symbolsOf(reorder(listOf('A', 'B', 'C'), 'C', 'A'))).toEqual(['C', 'A', 'B']);
  });

  it('moves downwards too', () => {
    expect(symbolsOf(reorder(listOf('A', 'B', 'C'), 'A', 'C'))).toEqual(['B', 'C', 'A']);
  });

  it('does nothing when a row is dropped on itself', () => {
    const before = listOf('A', 'B');
    expect(reorder(before, 'A', 'A')).toBe(before);
  });

  it('does nothing when either end is not in the list', () => {
    const before = listOf('A', 'B');
    expect(reorder(before, 'A', 'ZZZ')).toBe(before);
    expect(reorder(before, 'ZZZ', 'A')).toBe(before);
  });
});

describe('withNames', () => {
  it('takes the provider name over the placeholder', () => {
    const list = withNames(listOf('AAPL'), new Map([['AAPL', 'Apple Inc.']]));
    expect(list.entries[0].name).toBe('Apple Inc.');
  });

  it('leaves a name that is already better than the symbol alone', () => {
    const before: Watchlist = { version: 1, entries: [{ symbol: 'AAPL', name: 'My Apple' }] };
    expect(withNames(before, new Map([['AAPL', 'Apple Inc.']]))).toBe(before);
  });

  it('hands back the same list when nothing improved, so nothing is written', () => {
    const before = listOf('AAPL');
    expect(withNames(before, new Map())).toBe(before);
  });
});
