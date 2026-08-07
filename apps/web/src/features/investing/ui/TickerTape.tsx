import { type CSSProperties, useLayoutEffect, useRef, useState } from 'react';

import { FALLBACK_DURATION_SECONDS, loopDuration, tapeCycle } from '@/features/investing/lib/tape';
import { formatPercent, formatPrice } from '@/features/investing/lib/money';
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
  const groupRef = useRef<HTMLDivElement>(null);
  const [duration, setDuration] = useState(FALLBACK_DURATION_SECONDS);

  // The duration has to come from the measured width, because the thing being
  // held constant is speed and CSS cannot divide by a width it does not know.
  useLayoutEffect(() => {
    const group = groupRef.current;
    if (!group) return;

    const measure = () => setDuration(loopDuration(group.scrollWidth));
    measure();

    const observer = new ResizeObserver(measure);
    observer.observe(group);
    return () => observer.disconnect();
  }, [quotes]);

  if (!quotes.length) return null;

  const cycle = tapeCycle(quotes);
  const style = { '--tape-duration': `${duration}s` } as CSSProperties;

  // Two identical halves: the first is the tape, the second is what follows it
  // out of the frame. The copy is decoration — hidden from assistive tech and
  // out of the tab order, so nothing is announced or focused twice.
  const halves = [
    { key: 'lead', hidden: false },
    { key: 'trail', hidden: true },
  ];

  return (
    <div className={styles.tape} style={style} aria-label="Ticker tape">
      <div className={styles.track}>
        {halves.map((half) => (
          <div
            key={half.key}
            ref={half.hidden ? undefined : groupRef}
            className={styles.group}
            aria-hidden={half.hidden || undefined}
          >
            {cycle.map((quote, index) => {
              const rising = (quote.changePercent ?? 0) >= 0;
              return (
                <button
                  key={`${quote.symbol}-${index}`}
                  type="button"
                  className={`${styles.item} ${quote.extended ? styles.extended : ''}`}
                  // Only the first pass through the symbols is reachable; the
                  // repeats exist to fill the frame, not to be tabbed through.
                  tabIndex={half.hidden || index >= quotes.length ? -1 : undefined}
                  aria-hidden={index >= quotes.length || undefined}
                  title={quote.extended ? `${quote.symbol} — extended hours` : quote.symbol}
                  onClick={() => onSelect(quote.symbol)}
                >
                  <span className={styles.symbol}>{quote.symbol}</span>
                  <span className={styles.price}>{formatPrice(quote.price)}</span>
                  <span className={rising ? styles.up : styles.down}>
                    {formatPercent(quote.changePercent)}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}
