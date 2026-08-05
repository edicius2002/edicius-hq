import { describe, expect, it } from 'vitest';

import {
  applyPlatformFee,
  PLATFORM_FEE_MIN_GROSS,
  PLATFORM_FEE_RATE,
} from '@/features/greenlight/lib/fees';
import { buildSegmentSummaries, computeSegmentedTotals } from '@/features/greenlight/lib/segments';
import type { DayStats } from '@/features/greenlight/model/types';

function day(amount: number): DayStats {
  return { Deliverable: { amount, details: [] }, currency: 'USD' };
}

describe('platform fee (10% above the minimum gross)', () => {
  it('splits gross into fee and net once the minimum is reached', () => {
    const result = applyPlatformFee(2000);
    expect(PLATFORM_FEE_RATE).toBe(0.1);
    expect(result.gross).toBe(2000);
    expect(result.fee).toBeCloseTo(200);
    expect(result.net).toBeCloseTo(1800);
    expect(result.charged).toBe(true);
  });

  it('charges the fee exactly at the threshold', () => {
    expect(PLATFORM_FEE_MIN_GROSS).toBe(1000);
    const result = applyPlatformFee(PLATFORM_FEE_MIN_GROSS);
    expect(result.fee).toBeCloseTo(100);
    expect(result.net).toBeCloseTo(900);
    expect(result.charged).toBe(true);
  });

  it('deducts nothing below the threshold', () => {
    const result = applyPlatformFee(999.99);
    expect(result.fee).toBe(0);
    expect(result.net).toBeCloseTo(999.99);
    expect(result.feeRate).toBe(0);
    expect(result.charged).toBe(false);
  });

  it('treats each marker segment independently', () => {
    const stats: Record<string, DayStats> = {
      '2026-05-01': day(400),
      '2026-05-08': day(1200),
    };
    const segments = buildSegmentSummaries(stats, ['2026-05-01']);
    expect(segments).toHaveLength(2);

    // Under the minimum: nothing deducted.
    expect(segments[0]?.amount).toBe(400);
    expect(segments[0]?.fee).toBe(0);
    expect(segments[0]?.net).toBe(400);
    expect(segments[0]?.feeCharged).toBe(false);

    // At or above it: the full 10%.
    expect(segments[1]?.amount).toBe(1200);
    expect(segments[1]?.fee).toBeCloseTo(120);
    expect(segments[1]?.net).toBeCloseTo(1080);
    expect(segments[1]?.feeCharged).toBe(true);
  });

  it('totals charge per marker period, so they match the segment cards', () => {
    const stats: Record<string, DayStats> = {
      '2026-05-01': day(388),
      '2026-05-08': day(1200),
    };
    const markers = ['2026-05-01'];

    const totals = computeSegmentedTotals(stats, markers);
    const segments = buildSegmentSummaries(stats, markers);

    expect(totals.gross).toBe(1588);
    // Only the $1,200 period qualifies; the $388 one keeps its full gross.
    expect(totals.fee).toBeCloseTo(120);
    expect(totals.net).toBeCloseTo(1468);
    expect(totals.fee).toBeCloseTo(segments.reduce((sum, s) => sum + s.fee, 0));
    expect(totals.net).toBeCloseTo(segments.reduce((sum, s) => sum + s.net, 0));
  });

  it('without markers the whole range is one period charged at the flat rate', () => {
    const stats: Record<string, DayStats> = { '2026-05-01': day(388), '2026-05-08': day(1200) };
    const totals = computeSegmentedTotals(stats, []);
    expect(totals.gross).toBe(1588);
    expect(totals.fee).toBeCloseTo(158.8);
    expect(totals.charged).toBe(true);
  });

  it('reports no fee when every period stays under the minimum', () => {
    const stats: Record<string, DayStats> = { '2026-05-01': day(300), '2026-05-08': day(400) };
    const totals = computeSegmentedTotals(stats, ['2026-05-01']);
    expect(totals.fee).toBe(0);
    expect(totals.net).toBe(700);
    expect(totals.charged).toBe(false);
  });

  it('splitting a segment below the minimum removes its fee', () => {
    const stats: Record<string, DayStats> = {
      '2026-05-01': day(600),
      '2026-05-08': day(600),
    };

    const whole = buildSegmentSummaries(stats, ['2026-05-08']);
    expect(whole[0]?.amount).toBe(1200);
    expect(whole[0]?.fee).toBeCloseTo(120);

    const split = buildSegmentSummaries(stats, ['2026-05-01', '2026-05-08']);
    expect(split.map((segment) => segment.fee)).toEqual([0, 0]);
  });
});
