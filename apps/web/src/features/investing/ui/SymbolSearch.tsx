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

  /**
   * The symbol a pick last set `query` to, so the search effect below can
   * tell "the field holds what was just chosen" apart from "the field holds
   * something the user is still typing" — both are non-empty strings, but
   * only the second should re-open the results list and search again. Any
   * further edit clears it in `onChange`, which is what lets typing over a
   * picked symbol search again rather than staying stuck closed.
   *
   * State rather than a ref: the results list below reads it during render to
   * decide whether it is open at all.
   */
  const [picked, setPicked] = useState<string | null>(null);

  // Nothing to search: the field holds what was just picked, or the query is
  // too short. Cleared here, during render, rather than from the effect
  // below.
  if ((query === picked || query.trim().length < 2) && hits.length > 0) {
    setHits([]);
  }

  useEffect(() => {
    if (query === picked) return;

    const wanted = query.trim();
    if (wanted.length < 2) return;

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
  }, [query, picked]);

  /**
   * Picking sets the field to the symbol chosen rather than clearing it —
   * the ticker just picked is exactly what someone glancing at the field
   * next needs to see there, not a blank box with the confirmation living
   * only in a caller's own "Selected: X" line beside it.
   */
  function pick(hit: SymbolHit) {
    setPicked(hit.symbol);
    onPick(hit.symbol, hit.name);
    setQuery(hit.symbol);
    setHits([]);
  }

  return (
    <div className={styles.search} ref={boxRef}>
      <input
        className={styles.input}
        value={query}
        placeholder="Search a symbol"
        aria-label="Search a symbol"
        onChange={(event) => {
          setPicked(null);
          setQuery(event.target.value);
        }}
        onKeyDown={(event) => {
          // Enter with nothing chosen follows what was typed: a symbol you know
          // should not need the list to confirm it exists.
          if (event.key === 'Enter' && query.trim()) {
            // Both callers nest this inside their own <form>: left alone,
            // Enter's default action submits that form the instant a symbol
            // is picked, well before the rest of it has been filled in.
            event.preventDefault();
            pick(hits[0] ?? { symbol: query, name: query, kind: '', exchange: null });
          }
          if (event.key === 'Escape') setHits([]);
        }}
      />

      {query.trim().length >= 2 && query !== picked ? (
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
                  // The three spans below sit flush against each other in the
                  // markup — nothing but a CSS grid gap separates them
                  // visually — so their concatenated text is one run-on word
                  // to a screen reader. An explicit label gives the name the
                  // word breaks the layout only supplies visually.
                  aria-label={`${hit.symbol} ${hit.name} ${already ? 'following' : hit.kind}`}
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
