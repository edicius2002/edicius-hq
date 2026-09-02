import type { StorageKey } from '@/shared/storage/keys';

/**
 * A price alert: watch a symbol, and say so when it reaches a price.
 *
 * Kept as pure transitions over a value, the way `data/portfolio.ts` and
 * `data/watchlist.ts` are — the hook and the UI hold no rules, so creating,
 * editing and firing an alert can be tested without a browser.
 */

export const ALERT_RULES_KEY: StorageKey = 'alert-rules';

/**
 * What the user means by the alert, not which side of a line the price sits
 * on. The UI speaks in "buy at" and "sell at", and `lib/alertCross.ts` derives
 * the actual crossing direction from this — `buy` watches for the price
 * falling to or below `price`, `sell` for it rising to or above it.
 */
export type AlertKind = 'buy' | 'sell';

export type PriceAlert = {
  /**
   * Several alerts can watch the same symbol at once — a buy floor and a sell
   * ceiling on the same ticker are the normal case, not an edge case — so the
   * row's identity has to be its own id rather than the symbol, unlike
   * `Position` and `WatchlistEntry`.
   */
  id: string;
  symbol: string;
  kind: AlertKind;
  price: number;
  /**
   * Whether the alert is armed. A fired alert sets this to `false` itself
   * (see `markTriggered`) rather than needing a second "spent" flag — a
   * one-shot alert going quiet and a paused one going quiet are the same
   * state, and reactivating either means the same thing: watch again.
   */
  active: boolean;
  createdAt: number;
  /** When it last fired. Null until it has; shown in the UI once it isn't. */
  triggeredAt: number | null;
};

export type AlertRules = { version: 1; alerts: PriceAlert[] };

export const EMPTY_ALERT_RULES: AlertRules = { version: 1, alerts: [] };

/** A threshold of zero or below is not a price anything can cross down to. */
export function isUsablePrice(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Parse whatever storage returns.
 *
 * Same guard as `normalizePortfolio`/`normalizeWatchlist`: repair what can be
 * repaired, drop what would break an invariant, and never hand the UI or the
 * evaluator a shape they have to re-check.
 */
export function normalizeAlertRules(value: unknown): AlertRules {
  if (!value || typeof value !== 'object') return EMPTY_ALERT_RULES;

  const raw = (value as { alerts?: unknown }).alerts;
  if (!Array.isArray(raw)) return EMPTY_ALERT_RULES;

  const seen = new Set<string>();
  const alerts: PriceAlert[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const { id, symbol, kind, price, active, createdAt, triggeredAt } = entry as Record<
      string,
      unknown
    >;

    if (typeof id !== 'string' || !id || seen.has(id)) continue;
    if (typeof symbol !== 'string') continue;
    const cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol) continue;
    if (kind !== 'buy' && kind !== 'sell') continue;
    if (!isUsablePrice(price)) continue;

    seen.add(id);
    alerts.push({
      id,
      symbol: cleanSymbol,
      kind,
      price,
      active: typeof active === 'boolean' ? active : true,
      createdAt: typeof createdAt === 'number' && Number.isFinite(createdAt) ? createdAt : 0,
      triggeredAt:
        typeof triggeredAt === 'number' && Number.isFinite(triggeredAt) ? triggeredAt : null,
    });
  }

  return { version: 1, alerts };
}

/** Appends a fully-formed alert. The hook is what fills in `id`/`createdAt`. */
export function addAlert(rules: AlertRules, alert: PriceAlert): AlertRules {
  if (!isUsablePrice(alert.price) || !alert.symbol) return rules;
  return { version: 1, alerts: [...rules.alerts, alert] };
}

export type AlertPatch = { symbol?: string; kind?: AlertKind; price?: number };

/**
 * Changes an alert's own fields. Deliberately does not touch `active` or
 * `triggeredAt` — those go through `setActive`/`markTriggered`, which are the
 * only places that mean to change them, so an edit to the price cannot
 * accidentally reactivate an alert that was turned off on purpose.
 */
export function updateAlert(rules: AlertRules, id: string, patch: AlertPatch): AlertRules {
  const index = rules.alerts.findIndex((alert) => alert.id === id);
  if (index === -1) return rules;

  const current = rules.alerts[index];
  const next: PriceAlert = {
    ...current,
    ...(patch.symbol !== undefined ? { symbol: patch.symbol.trim().toUpperCase() } : {}),
    ...(patch.kind !== undefined ? { kind: patch.kind } : {}),
    ...(patch.price !== undefined ? { price: patch.price } : {}),
  };
  if (!next.symbol || !isUsablePrice(next.price)) return rules;

  const alerts = rules.alerts.map((alert, at) => (at === index ? next : alert));
  return { version: 1, alerts };
}

export function removeAlert(rules: AlertRules, id: string): AlertRules {
  const alerts = rules.alerts.filter((alert) => alert.id !== id);
  return alerts.length === rules.alerts.length ? rules : { version: 1, alerts };
}

export function setActive(rules: AlertRules, id: string, active: boolean): AlertRules {
  const index = rules.alerts.findIndex((alert) => alert.id === id);
  if (index === -1 || rules.alerts[index].active === active) return rules;

  const alerts = rules.alerts.map((alert, at) => (at === index ? { ...alert, active } : alert));
  return { version: 1, alerts };
}

/**
 * Records that an alert fired: it deactivates and remembers when, but stays
 * in the list rather than being deleted — the point of the timestamp is to
 * tell the user it went off, which only works if the row is still there to
 * read it on.
 */
export function markTriggered(rules: AlertRules, id: string, at: number): AlertRules {
  const index = rules.alerts.findIndex((alert) => alert.id === id);
  if (index === -1) return rules;

  const alerts = rules.alerts.map((alert, i) =>
    i === index ? { ...alert, active: false, triggeredAt: at } : alert,
  );
  return { version: 1, alerts };
}

export function alertsFor(rules: AlertRules, symbol: string): PriceAlert[] {
  const key = symbol.trim().toUpperCase();
  return rules.alerts.filter((alert) => alert.symbol === key);
}

/**
 * Every symbol carrying at least one active alert, deduplicated.
 *
 * This is the whole set of symbols the alert evaluator needs a quote for. It
 * deliberately does not depend on any page's watchlist or portfolio: an alert
 * on a symbol followed nowhere else must still get quoted, or it can never
 * fire.
 */
export function activeAlertSymbols(rules: AlertRules): string[] {
  const seen = new Set<string>();
  for (const alert of rules.alerts) if (alert.active) seen.add(alert.symbol);
  return [...seen];
}
