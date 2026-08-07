import { useEffect, useRef, useState } from 'react';

import { searchSymbols, type SymbolHit } from '@/shared/api/market';

import styles from './SymbolSearch.module.css';

/**
 * Find a symbol and follow it.
 *
 * The search is debounced because it runs against the same upstream budget
 * everything else does, and typing "microsoft" would otherwise be nine
 * requests for one answer.
 */
const DEBOUNCE_MS = 300;

type SymbolSearchProps = {
  onPick: (symbol: string, name: string) => void;
  /** Symbols already followed, shown as such rather than offered again. */
  following: Set<string>;
};

export function SymbolSearch({ onPick, following }: SymbolSearchProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [searching, setSearching] = useState(false);
  const boxRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const wanted = query.trim();
    if (wanted.length < 2) {
      setHits([]);
      return;
    }

    // Aborted on the next keystroke, so a slow answer for "mic" cannot land
    // after the answer for "micros" and overwrite it.
    const controller = new AbortController();
    const id = setTimeout(() => {
      setSearching(true);
      searchSymbols(wanted, controller.signal)
        .then((result) => setHits(result.results))
        .catch(() => setHits([]))
        .finally(() => setSearching(false));
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(id);
      controller.abort();
    };
  }, [query]);

  function pick(hit: SymbolHit) {
    onPick(hit.symbol, hit.name);
    setQuery('');
    setHits([]);
  }

  return (
    <div className={styles.search} ref={boxRef}>
      <input
        className={styles.input}
        value={query}
        placeholder="Search a symbol"
        aria-label="Search a symbol"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          // Enter with nothing chosen follows what was typed: a symbol you know
          // should not need the list to confirm it exists.
          if (event.key === 'Enter' && query.trim())
            pick(hits[0] ?? { symbol: query, name: query, kind: '', exchange: null });
          if (event.key === 'Escape') setHits([]);
        }}
      />

      {query.trim().length >= 2 ? (
        <ul className={styles.results} aria-label="Search results">
          {searching && !hits.length ? <li className={styles.hint}>Searching…</li> : null}
          {!searching && !hits.length ? <li className={styles.hint}>Nothing found.</li> : null}

          {hits.map((hit) => {
            const already = following.has(hit.symbol);
            return (
              <li key={`${hit.symbol}-${hit.exchange ?? ''}`}>
                <button
                  type="button"
                  className={styles.hit}
                  disabled={already}
                  onClick={() => pick(hit)}
                >
                  <span className={styles.hitSymbol}>{hit.symbol}</span>
                  <span className={styles.hitName}>{hit.name}</span>
                  <span className={styles.hitKind}>{already ? 'following' : hit.kind}</span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
