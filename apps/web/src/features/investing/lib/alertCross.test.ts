import { describe, expect, it } from 'vitest';

import {
  canCreateAlert,
  evaluateAlert,
  isRegularSessionQuote,
  seedFromPreviousClose,
  sideOf,
  type TrackedAlert,
} from './alertCross';

describe('sideOf', () => {
  it('a buy is met at or below its threshold', () => {
    expect(sideOf('buy', 199, 200)).toBe('met');
    expect(sideOf('buy', 201, 200)).toBe('unmet');
  });

  it('a sell is met at or above its threshold', () => {
    expect(sideOf('sell', 201, 200)).toBe('met');
    expect(sideOf('sell', 199, 200)).toBe('unmet');
  });

  it('a price exactly on the threshold counts as met, for both kinds', () => {
    expect(sideOf('buy', 200, 200)).toBe('met');
    expect(sideOf('sell', 200, 200)).toBe('met');
  });
});

describe('evaluateAlert', () => {
  const buyAt200 = { kind: 'buy' as const, price: 200 };

  it('never fires on the first price it ever sees — it only seeds the side', () => {
    const { fired, next } = evaluateAlert(buyAt200, 199, null);
    expect(fired).toBe(false);
    expect(next).toEqual({ price: 200, kind: 'buy', side: 'met' });
  });

  it('fires on the tick the price crosses from unmet to met', () => {
    const unmet: TrackedAlert = { price: 200, kind: 'buy', side: 'unmet' };
    const { fired, next } = evaluateAlert(buyAt200, 199, unmet);
    expect(fired).toBe(true);
    expect(next.side).toBe('met');
  });

  it('does not fire again on a later tick that is still in the zone', () => {
    const met: TrackedAlert = { price: 200, kind: 'buy', side: 'met' };
    const { fired } = evaluateAlert(buyAt200, 195, met);
    expect(fired).toBe(false);
  });

  it('re-arms after the price leaves the zone and crosses back', () => {
    const met: TrackedAlert = { price: 200, kind: 'buy', side: 'met' };
    const left = evaluateAlert(buyAt200, 210, met);
    expect(left.fired).toBe(false);
    expect(left.next.side).toBe('unmet');

    const back = evaluateAlert(buyAt200, 200, left.next);
    expect(back.fired).toBe(true);
  });

  it('fires a sell alert on the tick the price rises through its threshold', () => {
    const sellAt260 = { kind: 'sell' as const, price: 260 };
    const unmet: TrackedAlert = { price: 260, kind: 'sell', side: 'unmet' };
    const { fired } = evaluateAlert(sellAt260, 261, unmet);
    expect(fired).toBe(true);
  });

  describe('editing an armed alert', () => {
    it('re-seeds instead of firing when the price threshold changes underneath it', () => {
      // Tracked against the old threshold of 200, already unmet there.
      const staleAgainstOldPrice: TrackedAlert = { price: 200, kind: 'buy', side: 'unmet' };
      // The alert has since been edited to 190; the current price (195) is
      // unmet against the new threshold too, so a naive comparison against
      // the stale tracked state would see nothing to fire on the surface —
      // but the point is it must not silently keep comparing against 200.
      const edited = { kind: 'buy' as const, price: 190 };
      const { fired, next } = evaluateAlert(edited, 195, staleAgainstOldPrice);
      expect(fired).toBe(false);
      expect(next).toEqual({ price: 190, kind: 'buy', side: 'unmet' });
    });

    it('re-seeds instead of firing immediately when the edited price is already met', () => {
      const stale: TrackedAlert = { price: 200, kind: 'buy', side: 'unmet' };
      // Edited down to 190 while the price (185) already satisfies it — must
      // not fire on the spot; it only starts tracking from here.
      const edited = { kind: 'buy' as const, price: 190 };
      const { fired, next } = evaluateAlert(edited, 185, stale);
      expect(fired).toBe(false);
      expect(next.side).toBe('met');
    });

    it('re-seeds instead of firing when the kind changes underneath it', () => {
      const stale: TrackedAlert = { price: 200, kind: 'buy', side: 'met' };
      const editedToSell = { kind: 'sell' as const, price: 200 };
      const { fired, next } = evaluateAlert(editedToSell, 200, stale);
      expect(fired).toBe(false);
      expect(next.kind).toBe('sell');
    });

    it('resumes firing normally on the next genuine crossing after a re-seed', () => {
      const edited = { kind: 'buy' as const, price: 190 };
      const seeded = evaluateAlert(edited, 195, { price: 200, kind: 'buy', side: 'unmet' });
      expect(seeded.fired).toBe(false);

      const crossed = evaluateAlert(edited, 190, seeded.next);
      expect(crossed.fired).toBe(true);
    });
  });
});

describe('canCreateAlert', () => {
  it('refuses a buy whose target a regular-session price already meets', () => {
    expect(canCreateAlert('buy', 250, 240, true)).toBe(false);
    expect(canCreateAlert('buy', 250, 250, true)).toBe(false);
  });

  it('allows a buy whose target the current price has not reached yet', () => {
    expect(canCreateAlert('buy', 250, 260, true)).toBe(true);
  });

  it('refuses a sell whose target a regular-session price already meets', () => {
    expect(canCreateAlert('sell', 250, 260, true)).toBe(false);
  });

  it('allows a sell whose target the current price has not reached yet', () => {
    expect(canCreateAlert('sell', 250, 240, true)).toBe(true);
  });

  it('allows anything when there is no quote to judge it against', () => {
    expect(canCreateAlert('buy', 250, undefined, true)).toBe(true);
    expect(canCreateAlert('sell', 250, undefined, true)).toBe(true);
  });

  it('allows an already-met target when the price on hand is not from the regular session', () => {
    // Market closed, or extended hours: creation must still be possible —
    // there is nothing live to reject it against, only a stale reading.
    expect(canCreateAlert('buy', 250, 240, false)).toBe(true);
    expect(canCreateAlert('sell', 250, 260, false)).toBe(true);
  });
});

describe('isRegularSessionQuote', () => {
  it('is true only for a REGULAR market state', () => {
    expect(isRegularSessionQuote({ marketState: 'REGULAR' })).toBe(true);
  });

  it('is false for pre-market, post-market, closed, or an unknown state', () => {
    expect(isRegularSessionQuote({ marketState: 'PRE' })).toBe(false);
    expect(isRegularSessionQuote({ marketState: 'POST' })).toBe(false);
    expect(isRegularSessionQuote({ marketState: 'CLOSED' })).toBe(false);
    expect(isRegularSessionQuote({ marketState: null })).toBe(false);
  });
});

describe('seedFromPreviousClose', () => {
  const buyAt200 = { kind: 'buy' as const, price: 200 };

  it('seeds unmet when the previous close sits on the unmet side', () => {
    expect(seedFromPreviousClose(buyAt200, 210)).toEqual({
      price: 200,
      kind: 'buy',
      side: 'unmet',
    });
  });

  it('seeds met when the previous close already sits on the met side', () => {
    expect(seedFromPreviousClose(buyAt200, 195)).toEqual({ price: 200, kind: 'buy', side: 'met' });
  });

  it('returns null when there is no previous close to seed from', () => {
    expect(seedFromPreviousClose(buyAt200, null)).toBeNull();
  });

  it('lets a genuine overnight crossing fire on the first regular reading after it', () => {
    // Closed last night at 210 (unmet for a buy at 200); by the time the
    // market opens, the price has already crossed to 195.
    const seeded = seedFromPreviousClose(buyAt200, 210);
    const atOpen = evaluateAlert(buyAt200, 195, seeded);
    expect(atOpen.fired).toBe(true);
  });

  it('does not fire at the open when nothing crossed overnight', () => {
    const seeded = seedFromPreviousClose(buyAt200, 210);
    const atOpen = evaluateAlert(buyAt200, 205, seeded);
    expect(atOpen.fired).toBe(false);
  });
});
