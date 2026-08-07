import type { Quote } from '@/shared/api/market';

import styles from './TickerTape.module.css';

/**
 * The tape, across the top.
 *
 * Fed by the same quotes the watchlist uses rather than fetching its own. They
 * show the same symbols, so a second fetcher would double the request count for
 * identical data and let the two disagree on screen — which is worse than
 * either being slightly stale.
 */
type TickerTapeProps = {
  quotes: Quote[];
  onSelect: (symbol: string) => void;
};

export function TickerTape({ quotes, onSelect }: TickerTapeProps) {
  if (!quotes.length) return null;

  return (
    <div className={styles.tape} aria-label="Ticker tape">
      {quotes.map((quote) => {
        const rising = (quote.changePercent ?? 0) >= 0;
        return (
          <button
            key={quote.symbol}
            type="button"
            className={styles.item}
            onClick={() => onSelect(quote.symbol)}
          >
            <span className={styles.symbol}>{quote.symbol}</span>
            <span className={styles.price}>
              {quote.price.toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </span>
            <span className={rising ? styles.up : styles.down}>
              {quote.changePercent === null
                ? '—'
                : `${rising ? '+' : ''}${quote.changePercent.toFixed(2)}%`}
            </span>
          </button>
        );
      })}
    </div>
  );
}
