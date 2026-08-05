import { describe, expect, it } from 'vitest';

import { applyPlatformFee, PLATFORM_FEE_RATE } from '@/features/greenlight/lib/fees';
import { buildSegmentSummaries } from '@/features/greenlight/lib/segments';
import type { DayStats } from '@/features/greenlight/model/types';

describe('platform fee (10%)', () => {
  it('splits gross into fee and net', () => {
    const result = applyPlatformFee(1000);
    expect(PLATFORM_FEE_RATE).toBe(0.1);
    expect(result.gross).toBe(1000);
    expect(result.fee).toBeCloseTo(100);
    expect(result.net).toBeCloseTo(900);
  });

  it('applies fee per marker segment', () => {
    const stats: Record<string, DayStats> = {
      '2026-05-01': {
        Deliverable: { amount: 400, tasks: 2, attempter: 2, reviewer: 0, details: [] },
        currency: 'USD',
      },
      '2026-05-08': {
        Deliverable: { amount: 600, tasks: 3, attempter: 3, reviewer: 0, details: [] },
        currency: 'USD',
      },
    };
    const segments = buildSegmentSummaries(stats, ['2026-05-01']);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.amount).toBe(400);
    expect(segments[0]?.fee).toBeCloseTo(40);
    expect(segments[0]?.net).toBeCloseTo(360);
    expect(segments[1]?.amount).toBe(600);
    expect(segments[1]?.net).toBeCloseTo(540);
  });
});
