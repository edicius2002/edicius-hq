import type { AlertKind, PriceAlert } from '@/features/investing/data/priceAlerts';

/**
 * Detecting a price *crossing* a threshold, not merely sitting past one.
 *
 * `lib/latch.ts` is a rise-fast/fall-slow boolean built for connection
 * liveness — its grace period is the opposite of what a crossing wants, which
 * has to fire on the tick it happens, not after a delay. What is worth
 * copying from it is the shape: a small, pure, explicitly-transitioned state
 * value, fed real inputs so it can be tested without React or a market. That
 * shape is `evaluateAlert` below.
 */

/** Whether a price currently sits in the alert's target zone. */
export type AlertSide = 'met' | 'unmet';

/**
 * Whether `price` satisfies `kind` against `threshold`.
 *
 * A price exactly on the threshold counts as met, for both kinds — a buy at
 * 250 is satisfied by a tick that lands exactly on 250, not only by one that
 * goes strictly under it, and the same holds for a sell landing exactly on
 * its price. That is a deliberate reading of the user's intent ("buy at 250"
 * means 250 qualifies), not an accident of writing `<=`/`>=` instead of
 * `<`/`>`.
 */
export function sideOf(kind: AlertKind, price: number, threshold: number): AlertSide {
  return kind === 'buy'
    ? price <= threshold
      ? 'met'
      : 'unmet'
    : price >= threshold
      ? 'met'
      : 'unmet';
}

/** What is remembered between one evaluation and the next, per alert id. */
export type TrackedAlert = { price: number; kind: AlertKind; side: AlertSide };

export type Evaluation = { fired: boolean; next: TrackedAlert };

/**
 * One alert, one freshly observed price, against what was tracked for it
 * last time. Never persisted — see the price-alerts proposal on why a reload
 * losing this is the accepted cost of having no backend watcher.
 *
 * Fires only on the edge, `unmet` becoming `met`, never merely for sitting in
 * the zone — so a price that stays past the threshold for an hour does not
 * repeat the alert on every tick.
 *
 * Two situations are treated identically, as a "reseed": the very first price
 * ever observed for an alert (`previous === null`), and a price observed
 * after the alert's own `price` or `kind` changed underneath it. Both mean
 * "there is nothing honest to compare this price against" — the first because
 * the price could already have been past the threshold before anything was
 * watching (a reload, a freshly created alert), the second because the
 * previously tracked side describes a *different* target that no longer
 * exists. A reseed only records the current side; it can never fire. Without
 * this, editing an armed alert's price would either leave it mute forever (if
 * the tracked side keeps reading against the old threshold) or fire it on the
 * spot for a threshold it was never actually crossing.
 */
export function evaluateAlert(
  alert: Pick<PriceAlert, 'kind' | 'price'>,
  price: number,
  previous: TrackedAlert | null,
): Evaluation {
  const side = sideOf(alert.kind, price, alert.price);
  const reseed =
    previous === null || previous.price !== alert.price || previous.kind !== alert.kind;
  if (reseed) return { fired: false, next: { price: alert.price, kind: alert.kind, side } };

  return {
    fired: previous.side === 'unmet' && side === 'met',
    next: { price: alert.price, kind: alert.kind, side },
  };
}

/**
 * Whether a new alert can be created right now.
 *
 * An alert whose target is already met by the current price is refused: a
 * "buy at 250" created while the price already sits at 240 would otherwise
 * either fire the instant it is created (surprising — the user asked to be
 * told about a future crossing, not the present price) or, worse, sit armed
 * and silent forever because there is no crossing left to detect without a
 * previous "unmet" reading to cross from. Absent a quote there is nothing to
 * judge it against, so it is allowed — the same reasoning `valuePosition`
 * uses for a position with no quote yet.
 */
export function canCreateAlert(
  kind: AlertKind,
  price: number,
  currentPrice: number | undefined,
): boolean {
  if (currentPrice === undefined) return true;
  return sideOf(kind, currentPrice, price) === 'unmet';
}
