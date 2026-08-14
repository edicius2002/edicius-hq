import { describe, expect, it } from 'vitest';

import { parseAmount } from '@/features/greenlight/lib/parseAmount';

describe('parseAmount (TimeRecords export formats)', () => {
  it('reads a dotted decimal with two places, the form every Amount cell uses', () => {
    expect(parseAmount('1733.44')).toBe(1733.44);
    expect(parseAmount('1083.40')).toBe(1083.4);
    expect(parseAmount('20.00')).toBe(20);
    expect(parseAmount('10.84')).toBe(10.84);
  });

  it('reads the largest value in the sample export without a thousands mark', () => {
    expect(parseAmount('3882.50')).toBe(3882.5);
    expect(parseAmount('2275.14')).toBe(2275.14);
    expect(parseAmount('1365.00')).toBe(1365);
  });

  it('treats an empty or non-numeric cell as zero', () => {
    expect(parseAmount('')).toBe(0);
    expect(parseAmount('abc')).toBe(0);
  });
});
