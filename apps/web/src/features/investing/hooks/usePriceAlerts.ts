import { useCallback } from 'react';

import {
  ALERT_RULES_KEY,
  EMPTY_ALERT_RULES,
  addAlert,
  markTriggered,
  normalizeAlertRules,
  removeAlert,
  setActive,
  updateAlert,
  type AlertKind,
  type AlertPatch,
  type AlertRules,
} from '@/features/investing/data/priceAlerts';
import { useStoredDocument } from '@/shared/storage/useStoredDocument';

/**
 * The stored price alerts, edited through the same pure transitions the tests
 * use — structured exactly like `hooks/usePortfolio.ts`. Writes go through
 * the storage facade on the already-reserved `'alert-rules'` key, so they
 * stay serialised and are refused after a failed read. The rules live in
 * `data/priceAlerts`; nothing here decides anything.
 */
export function usePriceAlerts() {
  const store = useStoredDocument<AlertRules>({
    key: ALERT_RULES_KEY,
    normalize: normalizeAlertRules,
    placeholder: EMPTY_ALERT_RULES,
  });

  const rules = store.data;

  const add = useCallback(
    (input: { symbol: string; kind: AlertKind; price: number }) =>
      store.edit((current) =>
        addAlert(current, {
          id: crypto.randomUUID(),
          symbol: input.symbol.trim().toUpperCase(),
          kind: input.kind,
          price: input.price,
          active: true,
          createdAt: Date.now(),
          triggeredAt: null,
        }),
      ),
    [store],
  );

  const update = useCallback(
    (id: string, patch: AlertPatch) => store.edit((current) => updateAlert(current, id, patch)),
    [store],
  );

  const remove = useCallback(
    (id: string) => store.edit((current) => removeAlert(current, id)),
    [store],
  );

  const toggle = useCallback(
    (id: string, active: boolean) => store.edit((current) => setActive(current, id, active)),
    [store],
  );

  /** Called by the evaluator when a crossing fires. */
  const trigger = useCallback(
    (id: string, at: number = Date.now()) =>
      store.edit((current) => markTriggered(current, id, at)),
    [store],
  );

  return {
    rules,
    alerts: rules.alerts,
    isFetching: store.isFetching,
    isError: store.isError,
    add,
    update,
    remove,
    toggle,
    trigger,
  };
}
