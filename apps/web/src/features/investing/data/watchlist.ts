import type { StorageKey } from '@/shared/storage/keys';

/**
 * The watchlist, as it is stored and as it is edited.
 *
 * Kept as pure transitions over a value, the way the Finance document is: the
 * hook and the UI hold no rules, so reordering and de-duplication can be tested
 * without a browser.
 */

export const WATCHLIST_KEY: StorageKey = 'watchlist';

export type WatchlistEntry = {
  symbol: string;
  /** What to show when a quote has not arrived yet, or carries no name. */
  name: string;
};

export type Watchlist = {
  version: 1;
  entries: WatchlistEntry[];
};

export const EMPTY_WATCHLIST: Watchlist = { version: 1, entries: [] };

export function normalizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Parse whatever storage returns.
 *
 * Same guard as the Finance document: repair what can be repaired, drop what
 * would break an invariant, and never hand the UI a shape it has to re-check.
 */
export function normalizeWatchlist(value: unknown): Watchlist {
  if (typeof value !== 'object' || value === null) return EMPTY_WATCHLIST;

  const raw = (value as { entries?: unknown }).entries;
  if (!Array.isArray(raw)) return EMPTY_WATCHLIST;

  const entries: WatchlistEntry[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;

    // Checked rather than coerced: `String({})` is `[object Object]`, which
    // `normalizeSymbol` would happily uppercase into a symbol we would then go
    // and poll. The portfolio normalizer refuses the same way.
    const stored = (item as { symbol?: unknown }).symbol;
    if (typeof stored !== 'string') continue;
    const symbol = normalizeSymbol(stored);
    // One row per symbol: a duplicate would poll twice and flash twice.
    if (!symbol || seen.has(symbol)) continue;
    seen.add(symbol);

    const name = (item as { name?: unknown }).name;
    entries.push({ symbol, name: typeof name === 'string' ? name : symbol });
  }

  return { version: 1, entries };
}

export function addSymbol(list: Watchlist, symbol: string, name?: string): Watchlist {
  const clean = normalizeSymbol(symbol);
  if (!clean) return list;
  // Adding one that is already there is a no-op rather than a move: you asked
  // for it to be present, not for it to jump to the end.
  if (list.entries.some((entry) => entry.symbol === clean)) return list;

  return { ...list, entries: [...list.entries, { symbol: clean, name: name?.trim() || clean }] };
}

export function removeSymbol(list: Watchlist, symbol: string): Watchlist {
  const clean = normalizeSymbol(symbol);
  const entries = list.entries.filter((entry) => entry.symbol !== clean);
  return entries.length === list.entries.length ? list : { ...list, entries };
}

/** Move one row to where another sits, which is what a drop between rows means. */
export function reorder(list: Watchlist, from: string, to: string): Watchlist {
  const source = normalizeSymbol(from);
  const target = normalizeSymbol(to);
  if (source === target) return list;

  const fromIndex = list.entries.findIndex((entry) => entry.symbol === source);
  const toIndex = list.entries.findIndex((entry) => entry.symbol === target);
  if (fromIndex < 0 || toIndex < 0) return list;

  const entries = [...list.entries];
  const [moved] = entries.splice(fromIndex, 1);
  entries.splice(toIndex, 0, moved);
  return { ...list, entries };
}

/**
 * Fill in names a quote knows and the stored list does not.
 *
 * A symbol typed by hand starts with itself as its name; once the provider
 * answers with "Apple Inc." there is no reason to keep showing "AAPL" twice.
 */
export function withNames(list: Watchlist, names: Map<string, string>): Watchlist {
  let changed = false;
  const entries = list.entries.map((entry) => {
    const known = names.get(entry.symbol);
    if (!known || known === entry.name || entry.name !== entry.symbol) return entry;
    changed = true;
    return { ...entry, name: known };
  });
  return changed ? { ...list, entries } : list;
}

export function symbolsOf(list: Watchlist): string[] {
  return list.entries.map((entry) => entry.symbol);
}
