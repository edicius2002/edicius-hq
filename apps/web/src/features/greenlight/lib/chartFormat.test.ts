import { describe, expect, it } from 'vitest';

import {
  formatAxisMoney,
  formatBarMoney,
  niceCeiling,
  shortDate,
} from '@/features/greenlight/lib/chartFormat';

describe('formatAxisMoney', () => {
  it('abbreviates thousands, because an axis is not a ledger', () => {
    // "$17.6k" carries the same information as "$17,615.03" and leaves the
    // tick readable; two decimals repeated down an axis are two nobody reads.
    expect(formatAxisMoney(17615)).toBe('$17.6k');
    expect(formatAxisMoney(2000)).toBe('$2k');
  });

  it('drops the decimals below a thousand too', () => {
    expect(formatAxisMoney(365.4)).toBe('$365');
  });

  it('treats nothing as zero rather than as NaN', () => {
    expect(formatAxisMoney(Number.NaN)).toBe('$0');
  });
});

describe('formatBarMoney', () => {
  it('shows the whole figure while it fits', () => {
    expect(formatBarMoney(1365)).toBe('$1,365');
  });

  it('falls back to the abbreviation once it does not', () => {
    expect(formatBarMoney(120000)).toBe('$120k');
  });
});

describe('niceCeiling', () => {
  it('rounds up to something a human would choose for an axis top', () => {
    expect(niceCeiling(17615)).toBeGreaterThanOrEqual(17615);
    expect(niceCeiling(0)).toBeGreaterThan(0);
  });
});

describe('shortDate', () => {
  it('reads day over month, dropping the year the axis already implies', () => {
    expect(shortDate('2026-06-28')).toBe('28/06');
  });

  it('leaves anything it does not recognise alone', () => {
    expect(shortDate('June')).toBe('June');
  });
});
