import { describe, expect, it } from 'vitest';

import { formatPercent, formatPrice } from '@/features/investing/lib/money';

describe('formatPrice', () => {
  it('always writes two decimals, including the zeros', () => {
    // A column where one row reads 33.7 and the next 706.82 does not line up,
    // and the shorter number reads as a different kind of quantity.
    expect(formatPrice(33.7, 'en-US')).toBe('33.70');
    expect(formatPrice(706.4, 'en-US')).toBe('706.40');
    expect(formatPrice(26, 'en-US')).toBe('26.00');
  });

  it('does not round a sub-cent price down to nothing', () => {
    // 0.00 is not a rounder price, it is a wrong one — and this is why crypto
    // pairs exist in the same list as equities.
    expect(formatPrice(0.00001234, 'en-US')).toBe('0.00001234');
    expect(formatPrice(0.004, 'en-US')).toBe('0.004');
  });

  it('keeps two decimals at the boundary and below the sub-cent rule', () => {
    expect(formatPrice(0.01, 'en-US')).toBe('0.01');
    expect(formatPrice(0, 'en-US')).toBe('0.00');
  });

  it('groups thousands the way the locale does', () => {
    expect(formatPrice(64250.99, 'en-US')).toBe('64,250.99');
  });

  it('says nothing rather than NaN', () => {
    expect(formatPrice(Number.NaN)).toBe('—');
    expect(formatPrice(Number.POSITIVE_INFINITY)).toBe('—');
  });
});

describe('formatPercent', () => {
  it('signs the rise and writes two decimals', () => {
    expect(formatPercent(1.5)).toBe('+1.50%');
    expect(formatPercent(-0.1)).toBe('-0.10%');
    expect(formatPercent(0)).toBe('+0.00%');
  });

  it('says nothing when there is no previous close to measure against', () => {
    expect(formatPercent(null)).toBe('—');
  });
});
