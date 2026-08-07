import { useEffect, useRef, useState } from 'react';

import type { WatchlistEntry } from '@/features/investing/data/watchlist';
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

type WatchlistProps = {
  entries: WatchlistEntry[];
  quotes: Map<string, Quote>;
  selected: string;
  onSelect: (symbol: string) => void;
  onRemove: (symbol: string) => void;
  onMove: (from: string, to: string) => void;
};

type Flash = 'up' | 'down';

export function Watchlist({
  entries,
  quotes,
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
                    {quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
                  </span>
                  <span
                    className={`${rising ? styles.up : styles.down} ${
                      quote.extended ? styles.extended : ''
                    }`}
                  >
                    {quote.changePercent === null
                      ? '—'
                      : `${rising ? '+' : ''}${quote.changePercent.toFixed(2)}%`}
                  </span>
                </>
              ) : (
                <span className={styles.waiting}>·</span>
              )}
            </button>

            <button
              type="button"
              className={styles.remove}
              aria-label={`Remove ${entry.symbol}`}
              title={`Remove ${entry.symbol}`}
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
