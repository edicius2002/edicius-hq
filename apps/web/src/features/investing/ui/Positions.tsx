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
  formatAmount,
  formatQuantity,
  formatSignedAmount,
} from '@/shared/lib/money';
import type { Quote } from '@/shared/api/market';
import { SymbolSearch } from '@/features/investing/ui/SymbolSearch';

import styles from './Positions.module.css';

const NO_FOLLOWED_SYMBOLS = new Set<string>();

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
  const [adding, setAdding] = useState(false);

  const valued = portfolio.positions
    .map((position) => valuePosition(position, quotes.get(position.symbol)))
    .filter((valuation): valuation is Valuation => valuation !== null);

  return (
    <div>
      <div className={styles.add}>
        {adding ? (
          <PositionForm
            onCancel={() => setAdding(false)}
            onSave={(symbol, quantity, averageCost) => {
              onEdit(symbol, quantity, averageCost);
              setAdding(false);
            }}
          />
        ) : (
          <button type="button" className={styles.addButton} onClick={() => setAdding(true)}>
            Add position
          </button>
        )}
      </div>

      {portfolio.positions.length ? (
        <ul className={styles.list} aria-label="Positions">
          {portfolio.positions.map((position) => {
            const valuation = valuePosition(position, quotes.get(position.symbol));
            const rising = (valuation?.profit ?? 0) >= 0;

            if (editing === position.symbol) {
              return (
                <li key={position.symbol} className={styles.row}>
                  <PositionForm
                    initialSymbol={position.symbol}
                    quantity={position.quantity}
                    averageCost={position.averageCost}
                    onCancel={() => setEditing(null)}
                    onSave={(symbol, quantity, averageCost) => {
                      onEdit(symbol, quantity, averageCost);
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
                    {formatQuantity(position.quantity)} @ {formatAmount(position.averageCost)}
                  </span>

                  {valuation ? (
                    <>
                      <span className={styles.value}>{formatAmount(valuation.value)}</span>
                      <span className={rising ? styles.up : styles.down}>
                        {formatSignedAmount(valuation.profit)}
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
                    aria-label={'Edit ' + position.symbol + ' position'}
                    title={'Edit ' + position.symbol + ' position'}
                    onClick={() => setEditing(position.symbol)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    /* "position", because the watchlist beside it has a ✕ for
                     the same symbol and the two must not share a name. */
                    aria-label={'Remove ' + position.symbol + ' position'}
                    title={'Remove ' + position.symbol + ' position'}
                    onClick={() => onRemove(position.symbol)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.empty}>Nothing held yet.</p>
      )}

      {totalsByCurrency(valued).map((total) => (
        <div key={total.currency} className={styles.total}>
          <span className={styles.totalLabel}>
            Total <span className={styles.muted}>{total.currency}</span>
          </span>
          <span className={styles.totalValue}>{formatAmount(total.value)}</span>
          <span className={total.profit >= 0 ? styles.up : styles.down}>
            {formatSignedAmount(total.profit)}
            {total.profitPercent === null ? '' : ' · ' + formatPercent(total.profitPercent)}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Edited in place, because a dialog for a position is a dialog too many. */
function PositionForm({
  initialSymbol = '',
  quantity = '',
  averageCost = '',
  onSave,
  onCancel,
}: {
  initialSymbol?: string;
  quantity?: number | '';
  averageCost?: number | '';
  onSave: (symbol: string, quantity: number, averageCost: number) => void;
  onCancel: () => void;
}) {
  const [symbol, setSymbol] = useState(initialSymbol);
  const [qty, setQty] = useState(String(quantity));
  const [cost, setCost] = useState(String(averageCost));

  const normalizedSymbol = symbol.trim().toUpperCase();
  const parsedQty = Number(qty);
  const parsedCost = Number(cost);
  const valid =
    normalizedSymbol !== '' &&
    qty !== '' &&
    cost !== '' &&
    isUsableQuantity(parsedQty) &&
    isUsableCost(parsedCost);
  const adding = !initialSymbol;

  return (
    <form
      className={`${styles.form} ${adding ? styles.addForm : styles.editForm}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (valid) onSave(normalizedSymbol, parsedQty, parsedCost);
      }}
    >
      {initialSymbol ? (
        <span className={styles.symbol}>{initialSymbol}</span>
      ) : (
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Ticker</span>
          <SymbolSearch following={NO_FOLLOWED_SYMBOLS} onPick={(picked) => setSymbol(picked)} />
          {normalizedSymbol ? (
            <span className={styles.selectedSymbol} aria-live="polite">
              Selected: {normalizedSymbol}
            </span>
          ) : null}
        </div>
      )}
      <label className={styles.field}>
        {adding ? <span className={styles.fieldLabel}>Quantity</span> : null}
        <input
          className={styles.input}
          /* `step="any"` rather than a fixed step: 0.7 of a QQQ is a real
             position, and a stepper that refused it would refuse the data. */
          type="number"
          step="any"
          min="0"
          value={qty}
          aria-label={initialSymbol ? initialSymbol + ' position quantity' : 'Position quantity'}
          onChange={(event) => setQty(event.target.value)}
        />
      </label>
      <label className={styles.field}>
        {adding ? <span className={styles.fieldLabel}>Average cost</span> : null}
        <input
          className={styles.input}
          type="number"
          step="any"
          min="0"
          value={cost}
          aria-label={
            initialSymbol ? initialSymbol + ' position average cost' : 'Position average cost'
          }
          onChange={(event) => setCost(event.target.value)}
        />
      </label>
      <div className={styles.formActions}>
        <button
          type="submit"
          className={styles.action}
          disabled={!valid}
          aria-label={initialSymbol ? 'Save ' + initialSymbol + ' position' : 'Save position'}
        >
          ✓
        </button>
        <button
          type="button"
          className={styles.action}
          onClick={onCancel}
          aria-label={initialSymbol ? 'Cancel editing ' + initialSymbol : 'Cancel adding position'}
        >
          ✕
        </button>
      </div>
    </form>
  );
}
