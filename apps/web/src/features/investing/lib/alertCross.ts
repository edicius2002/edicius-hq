import type { AlertKind, PriceAlert } from '@/features/investing/data/priceAlerts';
import type { Quote } from '@/shared/api/market';

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
 * Whether a quote was printed during the regular session — as opposed to
 * pre-/post-market, or a stale last price handed back while the market is
 * fully closed. `marketState` is the one field that distinguishes all three;
 * a quote's own `extended` flag only ever means "pre- or post-market" and
 * says nothing about a market that isn't in any session at all, which a
 * closed weekend read still needs to be told apart from a regular one.
 * `null` is treated as not regular — nothing here should judge or fire
 * against a session nobody has confirmed.
 */
export function isRegularSessionQuote(quote: Pick<Quote, 'marketState'>): boolean {
  return quote.marketState === 'REGULAR';
}

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
 * previous "unmet" reading to cross from.
 *
 * That refusal only holds when the price being judged is itself a regular
 * quote. Outside the regular session there is no live reading to reject an
 * alert against in the first place — only a stale one, pre-/post-market or
 * a last close — and creation must still be possible around the clock: an
 * alert set up at 2am has to exist for the open to evaluate it against, not
 * be turned away because the only price on hand right then already reads as
 * met. The caller is expected to show that state instead (see
 * `ui/PriceAlerts.tsx`), never to silently create a mute alert.
 *
 * Absent a quote at all, there is nothing to judge it against either way, so
 * it is allowed — the same reasoning `valuePosition` uses for a position
 * with no quote yet.
 */
export function canCreateAlert(
  kind: AlertKind,
  price: number,
  currentPrice: number | undefined,
  isRegularSession: boolean,
): boolean {
  if (currentPrice === undefined || !isRegularSession) return true;
  return sideOf(kind, currentPrice, price) === 'unmet';
}

/**
 * The starting tracked state for an alert nobody has evaluated yet, anchored
 * to the last known *regular*-session price rather than to whatever price
 * happens to arrive first.
 *
 * Without this, an alert created overnight seeds itself from the very first
 * quote it observes — which, once extended and closed-market prints are
 * skipped (see `PriceAlertsWatcher`), is the opening regular print. Seeding
 * *from* that print rather than *against* it means a crossing that actually
 * happened between last night's close and this morning's open is never
 * detected: the first reading simply becomes the new baseline, silently.
 * Seeding from `previousClose` instead — a value every quote already
 * carries, no extra request needed — means the opening print is the first
 * thing genuinely *evaluated*, so a real overnight crossing fires right when
 * the regular session's first quote lands.
 *
 * Returns `null` when there is no previous close to seed from (a data gap,
 * a brand-new listing); the caller falls back to the plain first-observation
 * behaviour `evaluateAlert` already gives a `null` previous.
 */
export function seedFromPreviousClose(
  alert: Pick<PriceAlert, 'kind' | 'price'>,
  previousClose: number | null,
): TrackedAlert | null {
  if (previousClose === null) return null;
  return {
    price: alert.price,
    kind: alert.kind,
    side: sideOf(alert.kind, previousClose, alert.price),
  };
}
