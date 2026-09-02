import { describe, expect, it } from 'vitest';

import {
  activeAlertSymbols,
  addAlert,
  alertsFor,
  EMPTY_ALERT_RULES,
  isUsablePrice,
  markTriggered,
  normalizeAlertRules,
  removeAlert,
  setActive,
  updateAlert,
  type AlertRules,
  type PriceAlert,
} from './priceAlerts';

function alert(over: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: 'a1',
    symbol: 'AAPL',
    kind: 'buy',
    price: 200,
    active: true,
    createdAt: 1000,
    triggeredAt: null,
    ...over,
  };
}

describe('isUsablePrice', () => {
  it('accepts a positive finite number', () => {
    expect(isUsablePrice(200)).toBe(true);
  });

  it('rejects zero, negative, non-finite and non-number values', () => {
    expect(isUsablePrice(0)).toBe(false);
    expect(isUsablePrice(-5)).toBe(false);
    expect(isUsablePrice(NaN)).toBe(false);
    expect(isUsablePrice(Infinity)).toBe(false);
    expect(isUsablePrice('200')).toBe(false);
  });
});

describe('normalizeAlertRules', () => {
  it('returns the empty rules for anything that is not the right shape', () => {
    expect(normalizeAlertRules(null)).toEqual(EMPTY_ALERT_RULES);
    expect(normalizeAlertRules(undefined)).toEqual(EMPTY_ALERT_RULES);
    expect(normalizeAlertRules({})).toEqual(EMPTY_ALERT_RULES);
    expect(normalizeAlertRules({ alerts: 'nope' })).toEqual(EMPTY_ALERT_RULES);
  });

  it('keeps a well-formed alert, filling in defaults for missing optional fields', () => {
    const rules = normalizeAlertRules({
      alerts: [{ id: 'a1', symbol: 'aapl', kind: 'buy', price: 200 }],
    });
    expect(rules.alerts).toEqual([
      {
        id: 'a1',
        symbol: 'AAPL',
        kind: 'buy',
        price: 200,
        active: true,
        createdAt: 0,
        triggeredAt: null,
      },
    ]);
  });

  it('drops a row missing an id, a symbol, a valid kind, or a usable price', () => {
    const rules = normalizeAlertRules({
      alerts: [
        { symbol: 'AAPL', kind: 'buy', price: 200 },
        { id: 'a2', kind: 'buy', price: 200 },
        { id: 'a3', symbol: 'AAPL', kind: 'hold', price: 200 },
        { id: 'a4', symbol: 'AAPL', kind: 'buy', price: -5 },
        { id: 'a5', symbol: 'AAPL', kind: 'buy', price: 200 },
      ],
    });
    expect(rules.alerts.map((a) => a.id)).toEqual(['a5']);
  });

  it('drops a duplicate id, keeping the first', () => {
    const rules = normalizeAlertRules({
      alerts: [
        { id: 'a1', symbol: 'AAPL', kind: 'buy', price: 200 },
        { id: 'a1', symbol: 'MSFT', kind: 'sell', price: 400 },
      ],
    });
    expect(rules.alerts).toHaveLength(1);
    expect(rules.alerts[0].symbol).toBe('AAPL');
  });

  it('preserves a stored triggeredAt and a false active', () => {
    const rules = normalizeAlertRules({
      alerts: [
        { id: 'a1', symbol: 'AAPL', kind: 'buy', price: 200, active: false, triggeredAt: 5000 },
      ],
    });
    expect(rules.alerts[0]).toMatchObject({ active: false, triggeredAt: 5000 });
  });
});

describe('addAlert', () => {
  it('appends a well-formed alert', () => {
    const rules = addAlert(EMPTY_ALERT_RULES, alert());
    expect(rules.alerts).toEqual([alert()]);
  });

  it('refuses an alert with an unusable price', () => {
    const rules = addAlert(EMPTY_ALERT_RULES, alert({ price: 0 }));
    expect(rules).toBe(EMPTY_ALERT_RULES);
  });
});

describe('updateAlert', () => {
  it('changes the price and kind of the matching alert only', () => {
    const rules: AlertRules = {
      version: 1,
      alerts: [alert({ id: 'a1' }), alert({ id: 'a2', symbol: 'MSFT' })],
    };
    const next = updateAlert(rules, 'a1', { kind: 'sell', price: 260 });
    expect(next.alerts[0]).toMatchObject({ id: 'a1', kind: 'sell', price: 260 });
    expect(next.alerts[1]).toEqual(rules.alerts[1]);
  });

  it('leaves active and triggeredAt untouched — those go through setActive/markTriggered', () => {
    const rules: AlertRules = {
      version: 1,
      alerts: [alert({ active: false, triggeredAt: 5000 })],
    };
    const next = updateAlert(rules, 'a1', { price: 210 });
    expect(next.alerts[0]).toMatchObject({ active: false, triggeredAt: 5000, price: 210 });
  });

  it('is a no-op for an unknown id', () => {
    const rules: AlertRules = { version: 1, alerts: [alert()] };
    expect(updateAlert(rules, 'missing', { price: 999 })).toBe(rules);
  });

  it('refuses a patch that would leave an unusable price', () => {
    const rules: AlertRules = { version: 1, alerts: [alert()] };
    expect(updateAlert(rules, 'a1', { price: -1 })).toBe(rules);
  });
});

describe('removeAlert', () => {
  it('removes the matching alert and is a no-op otherwise', () => {
    const rules: AlertRules = { version: 1, alerts: [alert()] };
    expect(removeAlert(rules, 'a1').alerts).toEqual([]);
    expect(removeAlert(rules, 'missing')).toBe(rules);
  });
});

describe('setActive', () => {
  it('flips active and is identity when nothing changes', () => {
    const rules: AlertRules = { version: 1, alerts: [alert({ active: true })] };
    const next = setActive(rules, 'a1', false);
    expect(next.alerts[0].active).toBe(false);
    expect(setActive(next, 'a1', false)).toBe(next);
  });
});

describe('markTriggered', () => {
  it('deactivates and stamps the alert, keeping it in the list', () => {
    const rules: AlertRules = { version: 1, alerts: [alert({ active: true })] };
    const next = markTriggered(rules, 'a1', 9999);
    expect(next.alerts).toEqual([alert({ active: false, triggeredAt: 9999 })]);
  });
});

describe('alertsFor / activeAlertSymbols', () => {
  const rules: AlertRules = {
    version: 1,
    alerts: [
      alert({ id: 'a1', symbol: 'AAPL', active: true }),
      alert({ id: 'a2', symbol: 'AAPL', kind: 'sell', price: 260, active: false }),
      alert({ id: 'a3', symbol: 'MSFT', active: true }),
    ],
  };

  it('finds every alert for a symbol regardless of case', () => {
    expect(alertsFor(rules, 'aapl').map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('collects the deduplicated symbols carrying at least one active alert', () => {
    // AAPL has one active (a1) and one inactive (a2) alert; it counts once.
    expect(activeAlertSymbols(rules)).toEqual(['AAPL', 'MSFT']);
  });

  it('excludes a symbol whose only alerts are inactive', () => {
    const onlyInactive: AlertRules = {
      version: 1,
      alerts: [alert({ symbol: 'TSLA', active: false })],
    };
    expect(activeAlertSymbols(onlyInactive)).toEqual([]);
  });
});
