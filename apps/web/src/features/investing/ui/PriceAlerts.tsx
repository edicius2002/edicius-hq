import { useState } from 'react';

import {
  isUsablePrice,
  type AlertKind,
  type AlertPatch,
  type PriceAlert,
} from '@/features/investing/data/priceAlerts';
import { canCreateAlert } from '@/features/investing/lib/alertCross';
import { SymbolSearch } from '@/features/investing/ui/SymbolSearch';
import type { Quote } from '@/shared/api/market';
import { formatAmount } from '@/shared/lib/money';

import styles from './PriceAlerts.module.css';

const NO_FOLLOWED_SYMBOLS = new Set<string>();

const FIRED_FORMAT = new Intl.DateTimeFormat(undefined, {
  day: '2-digit',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * Every price alert, watched regardless of which symbol is charted.
 *
 * Structured like `ui/Positions.tsx`: a list of rows plus an inline form for
 * adding or editing one, rather than a dialog. The evaluator that actually
 * fires these lives above the router (`PriceAlertsWatcher.tsx`) — this panel
 * only edits the stored rules, the same separation `usePriceAlerts` keeps
 * between storage and evaluation.
 */
type PriceAlertsProps = {
  alerts: PriceAlert[];
  quotes: Map<string, Quote>;
  /** Prefilled into the add form — the symbol currently on the chart. */
  defaultSymbol: string;
  onAdd: (input: { symbol: string; kind: AlertKind; price: number }) => void;
  onUpdate: (id: string, patch: AlertPatch) => void;
  onRemove: (id: string) => void;
  onToggle: (id: string, active: boolean) => void;
};

export function PriceAlerts({
  alerts,
  quotes,
  defaultSymbol,
  onAdd,
  onUpdate,
  onRemove,
  onToggle,
}: PriceAlertsProps) {
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <div>
      <div className={styles.add}>
        {adding ? (
          <AlertForm
            defaultSymbol={defaultSymbol}
            quotes={quotes}
            onCancel={() => setAdding(false)}
            onSave={(input) => {
              onAdd(input);
              setAdding(false);
            }}
          />
        ) : (
          <button type="button" className={styles.addButton} onClick={() => setAdding(true)}>
            Add alert
          </button>
        )}
      </div>

      {alerts.length ? (
        <ul className={styles.list} aria-label="Price alerts">
          {alerts.map((alert) => {
            if (editing === alert.id) {
              return (
                <li key={alert.id} className={styles.row}>
                  <AlertForm
                    alert={alert}
                    quotes={quotes}
                    onCancel={() => setEditing(null)}
                    onSave={(input) => {
                      onUpdate(alert.id, input);
                      setEditing(null);
                    }}
                  />
                </li>
              );
            }

            return (
              <li key={alert.id} className={`${styles.row} ${alert.active ? '' : styles.inactive}`}>
                <div className={styles.info}>
                  <span className={styles.symbol}>{alert.symbol}</span>
                  <span className={alert.kind === 'buy' ? styles.buy : styles.sell}>
                    {alert.kind === 'buy' ? 'Buy' : 'Sell'} {formatAmount(alert.price)}
                  </span>
                  <span className={styles.status}>
                    {alert.triggeredAt !== null
                      ? `Fired ${FIRED_FORMAT.format(new Date(alert.triggeredAt))}`
                      : alert.active
                        ? 'Watching'
                        : 'Off'}
                  </span>
                </div>

                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.action}
                    aria-pressed={alert.active}
                    aria-label={
                      alert.active
                        ? `Turn off ${alert.symbol} alert`
                        : `Turn on ${alert.symbol} alert`
                    }
                    title={alert.active ? 'Turn off' : 'Turn on'}
                    onClick={() => onToggle(alert.id, !alert.active)}
                  >
                    {alert.active ? '⏸' : '▶'}
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    aria-label={`Edit ${alert.symbol} alert`}
                    title={`Edit ${alert.symbol} alert`}
                    onClick={() => setEditing(alert.id)}
                  >
                    ✎
                  </button>
                  <button
                    type="button"
                    className={styles.action}
                    aria-label={`Remove ${alert.symbol} alert`}
                    title={`Remove ${alert.symbol} alert`}
                    onClick={() => onRemove(alert.id)}
                  >
                    ✕
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className={styles.empty}>
          No alerts yet. Add one to be told when a symbol crosses a price.
        </p>
      )}
    </div>
  );
}

/** Edited in place, the same reasoning `Positions.tsx`'s form gives for its own. */
function AlertForm({
  alert,
  defaultSymbol = '',
  quotes,
  onSave,
  onCancel,
}: {
  alert?: PriceAlert;
  defaultSymbol?: string;
  quotes: Map<string, Quote>;
  onSave: (input: { symbol: string; kind: AlertKind; price: number }) => void;
  onCancel: () => void;
}) {
  const [symbol, setSymbol] = useState(alert?.symbol ?? defaultSymbol);
  const [kind, setKind] = useState<AlertKind>(alert?.kind ?? 'buy');
  const [price, setPrice] = useState(alert ? String(alert.price) : '');
  const [error, setError] = useState<string | null>(null);

  const normalizedSymbol = symbol.trim().toUpperCase();
  const parsedPrice = Number(price);
  const valid = normalizedSymbol !== '' && price !== '' && isUsablePrice(parsedPrice);

  return (
    <form
      className={`${styles.form} ${alert ? styles.editForm : styles.addForm}`}
      onSubmit={(event) => {
        event.preventDefault();
        if (!valid) return;

        // Refused rather than accepted-and-silent: an alert created past its
        // own target would either fire on the spot (not what "tell me when
        // it gets there" means) or, once `evaluateAlert`'s reseed rule takes
        // over, never fire at all until the price first moves away and back.
        // Absent a quote there is nothing to judge it against, so it passes.
        const currentPrice = quotes.get(normalizedSymbol)?.price;
        if (!canCreateAlert(kind, parsedPrice, currentPrice)) {
          setError(
            `${normalizedSymbol} is already ${kind === 'buy' ? 'at or below' : 'at or above'} ${formatAmount(parsedPrice)}.`,
          );
          return;
        }

        setError(null);
        onSave({ symbol: normalizedSymbol, kind, price: parsedPrice });
      }}
    >
      {alert ? (
        <span className={styles.symbol}>{alert.symbol}</span>
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

      <div className={styles.field}>
        <span className={styles.fieldLabel}>Kind</span>
        <div className={styles.kindGroup} role="group" aria-label="Alert kind">
          <button
            type="button"
            className={`${styles.kindButton} ${kind === 'buy' ? styles.kindOn : ''}`}
            aria-pressed={kind === 'buy'}
            onClick={() => setKind('buy')}
          >
            Buy
          </button>
          <button
            type="button"
            className={`${styles.kindButton} ${kind === 'sell' ? styles.kindOn : ''}`}
            aria-pressed={kind === 'sell'}
            onClick={() => setKind('sell')}
          >
            Sell
          </button>
        </div>
      </div>

      <label className={styles.field}>
        <span className={styles.fieldLabel}>Price</span>
        <input
          className={styles.input}
          type="number"
          step="any"
          min="0"
          value={price}
          onChange={(event) => setPrice(event.target.value)}
        />
      </label>

      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.formActions}>
        <button type="button" className={styles.cancel} onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className={styles.save} disabled={!valid}>
          Save
        </button>
      </div>
    </form>
  );
}
