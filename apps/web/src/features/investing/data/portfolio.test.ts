import { describe, expect, it } from 'vitest';

import {
  EMPTY_PORTFOLIO,
  normalizePortfolio,
  positionFor,
  removePosition,
  setPosition,
  symbolsOf,
  totalsByCurrency,
  valuePosition,
  type Portfolio,
} from '@/features/investing/data/portfolio';
import type { Quote } from '@/shared/api/market';

function quote(over: Partial<Quote> = {}): Quote {
  return {
    symbol: 'GLDM',
    price: 85.78,
    currency: 'USD',
    previousClose: 84,
    change: 1.78,
    changePercent: 2.11,
    provider: 'yahoo',
    marketState: 'REGULAR',
    name: 'SPDR Gold',
    extended: false,
    ...over,
  };
}

function portfolio(...positions: [string, number, number][]): Portfolio {
  return {
    version: 1,
    positions: positions.map(([symbol, quantity, averageCost]) => ({
      symbol,
      quantity,
      averageCost,
    })),
  };
}

describe('normalizePortfolio', () => {
  it('keeps fractional quantities exactly', () => {
    // 0.7 of a QQQ and 1.25 of a VOO are real positions in the migrated data.
    const out = normalizePortfolio({
      positions: [
        { symbol: 'QQQ', quantity: 0.7, averageCost: 717.501 },
        { symbol: 'VOO', quantity: 1.25, averageCost: 684.059 },
      ],
    });

    expect(out.positions[0].quantity).toBe(0.7);
    expect(out.positions[1].averageCost).toBe(684.059);
  });

  it('starts empty rather than guessing at a shape it does not know', () => {
    expect(normalizePortfolio(undefined)).toEqual(EMPTY_PORTFOLIO);
    expect(normalizePortfolio({ positions: 'GLDM' })).toEqual(EMPTY_PORTFOLIO);
    expect(normalizePortfolio([])).toEqual(EMPTY_PORTFOLIO);
  });

  it('drops a row it cannot compute with', () => {
    const out = normalizePortfolio({
      positions: [
        { symbol: 'GLDM', quantity: 3, averageCost: 80.74 },
        { symbol: 'BAD', quantity: 'two', averageCost: 1 },
        { symbol: 'ZERO', quantity: 0, averageCost: 1 },
        { symbol: 'NEG', quantity: 1, averageCost: -5 },
        { quantity: 1, averageCost: 1 },
      ],
    });

    // A quantity of zero is the absence of a position, not a position.
    expect(symbolsOf(out)).toEqual(['GLDM']);
  });

  it('accepts a cost of nothing, because something granted cost nothing', () => {
    const out = normalizePortfolio({ positions: [{ symbol: 'X', quantity: 1, averageCost: 0 }] });

    expect(out.positions).toHaveLength(1);
  });

  it('keeps the first of a duplicated symbol rather than letting order decide', () => {
    const out = normalizePortfolio({
      positions: [
        { symbol: 'GLDM', quantity: 3, averageCost: 80 },
        { symbol: 'gldm', quantity: 99, averageCost: 1 },
      ],
    });

    expect(out.positions).toHaveLength(1);
    expect(out.positions[0].quantity).toBe(3);
  });

  it('reads symbols in one case, whatever they were written in', () => {
    expect(
      symbolsOf(
        normalizePortfolio({ positions: [{ symbol: ' voo ', quantity: 1, averageCost: 1 }] }),
      ),
    ).toEqual(['VOO']);
  });
});

describe('setPosition', () => {
  it('edits in place rather than moving the row to the bottom', () => {
    // Correcting a cost should not make the row jump.
    const before = portfolio(['GLDM', 3, 80], ['VOO', 1, 600], ['PFE', 2, 26]);

    const after = setPosition(before, 'VOO', 1.25, 684.059);

    expect(symbolsOf(after)).toEqual(['GLDM', 'VOO', 'PFE']);
    expect(positionFor(after, 'VOO')).toEqual({
      symbol: 'VOO',
      quantity: 1.25,
      averageCost: 684.059,
    });
  });

  it('appends one it has not seen', () => {
    expect(symbolsOf(setPosition(EMPTY_PORTFOLIO, 'nvda', 1, 218.6))).toEqual(['NVDA']);
  });

  it('refuses a quantity or cost it cannot compute with', () => {
    const before = portfolio(['GLDM', 3, 80]);

    expect(setPosition(before, 'X', 0, 1)).toBe(before);
    expect(setPosition(before, 'X', Number.NaN, 1)).toBe(before);
    expect(setPosition(before, 'X', 1, -1)).toBe(before);
    expect(setPosition(before, '  ', 1, 1)).toBe(before);
  });
});

describe('removePosition', () => {
  it('takes the row out', () => {
    expect(symbolsOf(removePosition(portfolio(['A', 1, 1], ['B', 1, 1]), 'a'))).toEqual(['B']);
  });

  it('returns the same object when there was nothing to remove', () => {
    // Identity is what lets the storage facade skip a pointless write.
    const before = portfolio(['A', 1, 1]);
    expect(removePosition(before, 'Z')).toBe(before);
  });
});

describe('valuePosition', () => {
  it('values the holding and the profit against the average cost', () => {
    const out = valuePosition(
      { symbol: 'GLDM', quantity: 3, averageCost: 80.74 },
      quote({ price: 85.78 }),
    );

    expect(out).not.toBeNull();
    expect(out!.cost).toBeCloseTo(242.22);
    expect(out!.value).toBeCloseTo(257.34);
    expect(out!.profit).toBeCloseTo(15.12);
    expect(out!.profitPercent).toBeCloseTo(6.24, 2);
  });

  it('says nothing at all when no quote has arrived', () => {
    // Valuing it at zero would quietly leave a holding out of the total.
    expect(valuePosition({ symbol: 'X', quantity: 1, averageCost: 1 }, undefined)).toBeNull();
  });

  it('reports a loss as a loss', () => {
    const out = valuePosition(
      { symbol: 'SPCX', quantity: 2, averageCost: 138.011 },
      quote({ price: 128.81 }),
    );

    expect(out!.profit).toBeCloseTo(-18.402, 3);
    expect(out!.profitPercent).toBeLessThan(0);
  });

  it('has no percentage on something that cost nothing', () => {
    const out = valuePosition({ symbol: 'X', quantity: 5, averageCost: 0 }, quote({ price: 10 }));

    expect(out!.profit).toBe(50);
    expect(out!.profitPercent).toBeNull();
  });
});

describe('totalsByCurrency', () => {
  const value = (symbol: string, currency: string, cost: number, price: number, qty: number) =>
    valuePosition(
      { symbol, quantity: qty, averageCost: cost },
      quote({ symbol, currency, price }),
    )!;

  it('sums a single currency into one line', () => {
    const totals = totalsByCurrency([
      value('GLDM', 'USD', 80.74, 85.78, 3),
      value('PFE', 'USD', 26.159, 26.48, 2),
    ]);

    expect(totals).toHaveLength(1);
    expect(totals[0].positions).toBe(2);
    expect(totals[0].value).toBeCloseTo(257.34 + 52.96, 2);
  });

  it('never adds two currencies into one number', () => {
    // Summing them would be a conversion at a rate nobody chose.
    const totals = totalsByCurrency([
      value('GLDM', 'USD', 80.74, 85.78, 3),
      value('BTCUSDT', 'USDT', 60000, 64825.58, 0.1),
    ]);

    expect(totals.map((t) => t.currency).sort()).toEqual(['USD', 'USDT']);
  });

  it('puts the currency you hold most of first', () => {
    const totals = totalsByCurrency([
      value('A', 'USD', 1, 1, 1),
      value('B', 'USDT', 1, 1000, 1000),
    ]);

    expect(totals[0].currency).toBe('USDT');
  });

  it('gives no total at all when nothing could be valued', () => {
    expect(totalsByCurrency([])).toEqual([]);
  });
});
