import { describe, expect, it } from 'vitest';

import {
  DEFAULT_ANNUAL_RATE,
  PROJECTION_MONTHS,
  effectiveAnnualRate,
  firstYearInterest,
  formatRate,
  monthlyRate,
  projectMonths,
  yearsFrom,
} from '@/features/greenlight/lib/compound';

/**
 * The projection, against figures worked out by hand.
 *
 * Greenlight's net on the day this was written — the same $20,377.80 the
 * headline shows — so every expectation below is a number somebody can check
 * on a calculator rather than one this file agreed with itself about.
 */
const CAPITAL = 20377.8;

describe('the monthly rate', () => {
  it('is the annual rate divided by twelve, and not the twelfth root of it', () => {
    expect(monthlyRate(6)).toBeCloseTo(0.005, 12);
    // The equivalent-yield reading, which is a correct answer to a different
    // question and is not the convention this section is built on.
    expect(1.06 ** (1 / 12) - 1).toBeCloseTo(0.00486755, 8);
  });

  it('costs $581.77 over ten years to get that convention wrong', () => {
    /*
     * Measured rather than taken on trust. The brief for this section put the
     * cost of the wrong convention at "about $70"; on these figures it is
     * $581.77, and the only reading that lands near $70 is continuous
     * compounding, which is $55.47 *above* the nominal answer rather than below
     * it. Either way the convention is the one thing here worth a test.
     */
    const nominal = projectMonths(CAPITAL, 6).at(-1)!.balance;
    const equivalent = CAPITAL * 1.06 ** 10;
    expect(nominal).toBeCloseTo(37075.3, 2);
    expect(equivalent).toBeCloseTo(36493.54, 2);
    expect(nominal - equivalent).toBeCloseTo(581.77, 2);
    expect(CAPITAL * Math.exp(0.6) - nominal).toBeCloseTo(55.47, 2);
  });

  it('is zero for a rate that is not a number, rather than NaN through the whole table', () => {
    expect(monthlyRate(Number.NaN)).toBe(0);
    expect(projectMonths(CAPITAL, Number.NaN).at(-1)!.balance).toBe(CAPITAL);
  });
});

describe('the effective annual rate', () => {
  it('is 6.1678% for 6% paid monthly', () => {
    expect(effectiveAnnualRate(6)).toBeCloseTo(6.167781, 6);
  });

  it('is what the first year actually pays, and more than the nominal rate', () => {
    const rows = projectMonths(CAPITAL, 6);
    const yearOne = firstYearInterest(rows);
    expect(yearOne / CAPITAL).toBeCloseTo(effectiveAnnualRate(6) / 100, 10);
    // The number that looks like a mistake without the effective rate beside it.
    expect(yearOne).toBeGreaterThan(CAPITAL * 0.06);
    expect(yearOne - CAPITAL * 0.06).toBeCloseTo(34.19, 2);
  });
});

describe('the projection', () => {
  const rows = projectMonths(CAPITAL, DEFAULT_ANNUAL_RATE);

  it('runs ten years of months', () => {
    expect(rows).toHaveLength(PROJECTION_MONTHS);
    expect(rows[0].month).toBe(1);
    expect(rows.at(-1)!.month).toBe(120);
  });

  it('earns $101.89 in month 1', () => {
    expect(rows[0].interest).toBeCloseTo(101.889, 3);
    expect(rows[0].balance).toBeCloseTo(20479.689, 3);
  });

  it('earns more in month 2 than in month 1, because month 1 was left in', () => {
    expect(rows[1].interest).toBeGreaterThan(rows[0].interest);
    expect(rows[1].interest).toBeCloseTo(102.398, 3);
    // Simple interest would have paid the same $101.889 twice.
    expect(rows[1].interest - rows[0].interest).toBeCloseTo(0.509, 3);
  });

  it('closes month 12 at $21,634.66', () => {
    expect(rows[11].balance).toBeCloseTo(21634.66, 2);
    expect(firstYearInterest(rows)).toBeCloseTo(1256.86, 2);
  });

  it('carries the gain since the start on every row', () => {
    expect(rows[0].gain).toBeCloseTo(rows[0].interest, 10);
    expect(rows[11].gain).toBeCloseTo(1256.86, 2);
    expect(rows.at(-1)!.gain).toBeCloseTo(16697.5, 2);
  });
});

describe('the years the table names', () => {
  const rows = projectMonths(CAPITAL, DEFAULT_ANNUAL_RATE);

  it('is exactly 1, 2, 3, 5 and 10', () => {
    expect(yearsFrom(rows).map((year) => year.year)).toEqual([1, 2, 3, 5, 10]);
  });

  it('agrees with the figures worked out by hand', () => {
    const byYear = new Map(yearsFrom(rows).map((year) => [year.year, year]));
    expect(byYear.get(1)!.balance).toBeCloseTo(21634.66, 2);
    expect(byYear.get(2)!.balance).toBeCloseTo(22969.04, 2);
    expect(byYear.get(3)!.balance).toBeCloseTo(24385.72, 2);
    expect(byYear.get(5)!.balance).toBeCloseTo(27486.6, 2);
    expect(byYear.get(10)!.balance).toBeCloseTo(37075.3, 2);

    expect(byYear.get(1)!.gain).toBeCloseTo(1256.86, 2);
    expect(byYear.get(2)!.gain).toBeCloseTo(2591.24, 2);
    expect(byYear.get(3)!.gain).toBeCloseTo(4007.92, 2);
    expect(byYear.get(5)!.gain).toBeCloseTo(7108.8, 2);
    expect(byYear.get(10)!.gain).toBeCloseTo(16697.5, 2);
  });

  it('reads the months rather than recomputing them, so the two tables cannot disagree', () => {
    // Year 1 and the twelfth row of the first-year table are the same object's
    // figures. Recomputing `capital * (1 + r) ** 12` beside the loop is how a
    // page ends up printing two balances for one month.
    expect(yearsFrom(rows)[0].balance).toBe(rows[11].balance);
    expect(yearsFrom(rows).at(-1)!.balance).toBe(rows[119].balance);
  });

  it('drops a year the projection does not reach instead of extrapolating', () => {
    expect(yearsFrom(projectMonths(CAPITAL, 6, 30))).toHaveLength(2);
  });
});

describe('a capital there is nothing to compound', () => {
  /*
   * Zero and below yield no rows at all. A negative balance at 6% is arithmetic
   * that runs perfectly happily and describes a debt rather than a deposit —
   * the projector would print a confident spiral downwards for what is almost
   * always a typo.
   */
  it('projects nothing from zero', () => {
    expect(projectMonths(0, 6)).toEqual([]);
  });

  it('projects nothing from a negative capital', () => {
    expect(projectMonths(-20377.8, 6)).toEqual([]);
    expect(yearsFrom(projectMonths(-1, 6))).toEqual([]);
    expect(firstYearInterest(projectMonths(-1, 6))).toBe(0);
  });

  it('projects nothing from a capital that is not a number', () => {
    expect(projectMonths(Number.NaN, 6)).toEqual([]);
    expect(projectMonths(Number.POSITIVE_INFINITY, 6)).toEqual([]);
  });
});

describe('a rate on screen', () => {
  it('keeps the digits it is asked for, so 0.5 reads as a monthly rate', () => {
    expect(formatRate(0.5, 3, 'en-US')).toBe('0.500');
    expect(formatRate(effectiveAnnualRate(6), 4, 'en-US')).toBe('6.1678');
  });

  it('follows the locale, like every other number on the page', () => {
    // `es-PE` writes a point here, so it would not prove anything.
    expect(formatRate(6.167781, 4, 'es-ES')).toBe('6,1678');
  });
});
