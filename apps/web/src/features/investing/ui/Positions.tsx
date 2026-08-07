import { useState } from 'react';

import {
  isUsableCost,
  isUsableQuantity,
  totalsByCurrency,
  valuePosition,
  type Portfolio,
  type Valuation,
} from '@/features/investing/data/portfolio';
import {
  formatPercent,
  formatPrice,
  formatQuantity,
  formatSignedPrice,
} from '@/features/investing/lib/money';
import type { Quote } from '@/shared/api/market';

import styles from './Positions.module.css';

/**
 * What you own, and what it is worth.
 *
 * Fed by the quotes the watchlist and tape already share, so a position moves
 * with the stream at no extra request. A row whose quote has not arrived says
 * so rather than valuing itself at zero — a total quietly missing one of its
 * holdings would be worse than one admitting it is still loading.
 */
type PositionsProps = {
  portfolio: Portfolio;
  quotes: Map<string, Quote>;
  selected: string;
  onSelect: (symbol: string) => void;
  onEdit: (symbol: string, quantity: number, averageCost: number) => void;
  onRemove: (symbol: string) => void;
};

export function Positions({
  portfolio,
  quotes,
  selected,
  onSelect,
  onEdit,
  onRemove,
}: PositionsProps) {
  const [editing, setEditing] = useState<string | null>(null);

  if (!portfolio.positions.length) {
    return <p className={styles.empty}>Nothing held yet.</p>;
  }

  const valued = portfolio.positions
    .map((position) => valuePosition(position, quotes.get(position.symbol)))
    .filter((valuation): valuation is Valuation => valuation !== null);

  return (
    <div>
      <ul className={styles.list} aria-label="Positions">
        {portfolio.positions.map((position) => {
          const valuation = valuePosition(position, quotes.get(position.symbol));
          const rising = (valuation?.profit ?? 0) >= 0;

          if (editing === position.symbol) {
            return (
              <li key={position.symbol} className={styles.row}>
                <PositionForm
                  symbol={position.symbol}
                  quantity={position.quantity}
                  averageCost={position.averageCost}
                  onCancel={() => setEditing(null)}
                  onSave={(quantity, averageCost) => {
                    onEdit(position.symbol, quantity, averageCost);
                    setEditing(null);
                  }}
                />
              </li>
            );
          }

          return (
            <li
              key={position.symbol}
              className={`${styles.row} ${position.symbol === selected ? styles.selected : ''}`}
            >
              <button
                type="button"
                className={styles.pick}
                onClick={() => onSelect(position.symbol)}
              >
                <span className={styles.symbol}>{position.symbol}</span>
                <span className={styles.holding}>
                  {formatQuantity(position.quantity)} @ {formatPrice(position.averageCost)}
                </span>

                {valuation ? (
                  <>
                    <span className={styles.value}>{formatPrice(valuation.value)}</span>
                    <span className={rising ? styles.up : styles.down}>
                      {formatSignedPrice(valuation.profit)}
                      {valuation.profitPercent === null
                        ? ''
                        : ' · ' + formatPercent(valuation.profitPercent)}
                    </span>
                  </>
                ) : (
                  <span className={styles.waiting}>waiting for a price</span>
                )}
              </button>

              <div className={styles.actions}>
                <button
                  type="button"
                  className={styles.action}
                  aria-label={'Edit ' + position.symbol}
                  onClick={() => setEditing(position.symbol)}
                >
                  ✎
                </button>
                <button
                  type="button"
                  className={styles.action}
                  aria-label={'Remove ' + position.symbol}
                  onClick={() => onRemove(position.symbol)}
                >
                  ✕
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      {totalsByCurrency(valued).map((total) => (
        <div key={total.currency} className={styles.total}>
          <span className={styles.totalLabel}>
            Total <span className={styles.muted}>{total.currency}</span>
          </span>
          <span className={styles.totalValue}>{formatPrice(total.value)}</span>
          <span className={total.profit >= 0 ? styles.up : styles.down}>
            {formatSignedPrice(total.profit)}
            {total.profitPercent === null ? '' : ' · ' + formatPercent(total.profitPercent)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Edited in place, because a dialog for two numbers is a dialog too many. */
function PositionForm({
  symbol,
  quantity,
  averageCost,
  onSave,
  onCancel,
}: {
  symbol: string;
  quantity: number;
  averageCost: number;
  onSave: (quantity: number, averageCost: number) => void;
  onCancel: () => void;
}) {
  const [qty, setQty] = useState(String(quantity));
  const [cost, setCost] = useState(String(averageCost));

  const parsedQty = Number(qty);
  const parsedCost = Number(cost);
  const valid =
    qty !== '' && cost !== '' && isUsableQuantity(parsedQty) && isUsableCost(parsedCost);

  return (
    <form
      className={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(parsedQty, parsedCost);
      }}
    >
      <span className={styles.symbol}>{symbol}</span>
      <input
        className={styles.input}
        /* `step="any"` rather than a fixed step: 0.7 of a QQQ is a real
           position, and a stepper that refused it would refuse the data. */
        type="number"
        step="any"
        min="0"
        value={qty}
        aria-label={symbol + ' quantity'}
        onChange={(event) => setQty(event.target.value)}
      />
      <input
        className={styles.input}
        type="number"
        step="any"
        min="0"
        value={cost}
        aria-label={symbol + ' average cost'}
        onChange={(event) => setCost(event.target.value)}
      />
      <button type="submit" className={styles.action} disabled={!valid} aria-label="Save">
        ✓
      </button>
      <button type="button" className={styles.action} onClick={onCancel} aria-label="Cancel">
        ✕
      </button>
    </form>
  );
}
