import { useEffect, useRef, useState } from 'react';

import type { WatchlistEntry } from '@/features/investing/data/watchlist';
import { formatPercent, formatAmount } from '@/shared/lib/money';
import type { Quote } from '@/shared/api/market';

import styles from './Watchlist.module.css';

/**
 * The watchlist, as a sidebar to the chart.
 *
 * Rows flash when their price changes. On a dense list a number quietly
 * replacing another is invisible — the flash is the only thing that says
 * something moved, which is the whole reason to have the list on screen rather
 * than a chart alone.
 */

/** Long enough to catch the eye, short enough not to still be lit on the next tick. */
const FLASH_MS = 600;

/** What the provider said about a symbol it would not serve. */
export type Failure = { code: string; message: string };

/**
 * Said in the row rather than in a banner, because it is about that symbol and
 * not about the page. Kept short: the code is the useful part and the full
 * message is one hover away.
 */
const FAILURE_LABEL: Record<string, string> = {
  'rate-limited': 'rate limited',
  'symbol-not-found': 'unknown symbol',
  'no-price': 'no price',
  unreachable: 'unreachable',
  'upstream-error': 'upstream error',
};

type WatchlistProps = {
  entries: WatchlistEntry[];
  quotes: Map<string, Quote>;
  /** Symbols the provider refused, by symbol. Rendered in place of a price. */
  failures?: Map<string, Failure>;
  selected: string;
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onMove: (from: string, to: string) => void;
};

type Flash = 'up' | 'down';

export function Watchlist({
  entries,
  quotes,
  failures,
  selected,
  onSelect,
  onRemove,
  onMove,
}: WatchlistProps) {
  const flashes = useFlashes(quotes);
  const [dragging, setDragging] = useState<string | null>(null);

  if (!entries.length) {
    return <p className={styles.empty}>Nothing followed yet. Search for a symbol to add one.</p>;
  }

  return (
    <ul className={styles.list} aria-label="Watchlist">
      {entries.map((entry) => {
        const quote = quotes.get(entry.symbol);
        const failure = quote ? undefined : failures?.get(entry.symbol);
        const rising = (quote?.changePercent ?? 0) >= 0;
        const flash = flashes.get(entry.symbol);

        return (
          <li
            key={entry.symbol}
            className={[
              styles.row,
              entry.symbol === selected ? styles.selected : '',
              dragging === entry.symbol ? styles.dragging : '',
              flash === 'up' ? styles.flashUp : flash === 'down' ? styles.flashDown : '',
            ]
              .filter(Boolean)
              .join(' ')}
            draggable
            onDragStart={() => setDragging(entry.symbol)}
            onDragEnd={() => setDragging(null)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => {
              if (dragging && dragging !== entry.symbol) onMove(dragging, entry.symbol);
              setDragging(null);
            }}
          >
            <button
              type="button"
              className={styles.pick}
              aria-current={entry.symbol === selected}
              onClick={() => onSelect(entry.symbol)}
            >
              <span className={styles.symbol}>{entry.symbol}</span>
              <span className={styles.name}>{entry.name}</span>

              {quote ? (
                <>
                  <span
                    className={`${styles.price} ${quote.extended ? styles.extended : ''}`}
                    title={quote.extended ? 'Extended-hours price' : undefined}
                  >
                    {formatAmount(quote.price)}
                  </span>
                  <span
                    className={`${rising ? styles.up : styles.down} ${
                      quote.extended ? styles.extended : ''
                    }`}
                  >
                    {formatPercent(quote.changePercent)}
                  </span>
                </>
              ) : failure ? (
                /*
                 * A refused row used to show the same "·" as one that had not
                 * loaded yet, forever — so a rate-limited symbol was
                 * indistinguishable from a slow one, and decision 8.8 sent the
                 * reason all the way here for nothing.
                 */
                <span className={styles.failed} title={failure.message}>
                  {FAILURE_LABEL[failure.code] ?? failure.code}
                </span>
              ) : (
                <span className={styles.waiting}>·</span>
              )}
            </button>

            <button
              type="button"
              className={styles.remove}
              /* Names the list it acts on. The positions panel beside it has
                 its own ✕ for the same symbol, and two controls answering to
                 one name are ambiguous to a screen reader — and picked the
                 wrong one out of the document when a check went looking. */
              aria-label={`Stop following ${entry.symbol}`}
              title={`Stop following ${entry.symbol}`}
              onClick={() => onRemove(entry.symbol)}
            >
              ✕
            </button>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Which rows moved since the last tick, and which way.
 *
 * Held in a ref rather than state so comparing prices does not itself cause the
 * render that would compare them again.
 */
function useFlashes(quotes: Map<string, Quote>): Map<string, Flash> {
  const previous = useRef(new Map<string, number>());
  const [flashes, setFlashes] = useState<Map<string, Flash>>(new Map());

  useEffect(() => {
    const next = new Map<string, Flash>();
    for (const [symbol, quote] of quotes) {
      const before = previous.current.get(symbol);
      if (before !== undefined && before !== quote.price) {
        next.set(symbol, quote.price > before ? 'up' : 'down');
      }
      previous.current.set(symbol, quote.price);
    }

    if (!next.size) return;
    setFlashes(next);
    const id = setTimeout(() => setFlashes(new Map()), FLASH_MS);
    return () => clearTimeout(id);
  }, [quotes]);

  return flashes;
}
