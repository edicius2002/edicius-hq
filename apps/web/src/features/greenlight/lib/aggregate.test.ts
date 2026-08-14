import { describe, expect, it } from 'vitest';

import {
  buildMonthGroups,
  buildMonthlySeries,
  buildWeeklySeries,
} from '@/features/greenlight/lib/aggregate';
import { currentMonthKey, currentMonthLabel, mergeCurrentMonthStats } from '@/features/greenlight/lib/merge';
import { buildSegmentSummaries } from '@/features/greenlight/lib/segments';
import type { DayStats } from '@/features/greenlight/model/types';

function day(amount: number): DayStats {
  return {
    Deliverable: {
      amount,
      details: [],
    },
    currency: 'USD',
  };
}

const SAMPLE: Record<string, DayStats> = {
  '2026-05-01': day(420),
  '2026-05-08': day(560),
  '2026-05-15': day(610),
};

describe('Greenlight aggregation (legacy parity)', () => {
  it('builds weekly and monthly series', () => {
    const weekly = buildWeeklySeries(SAMPLE);
    const monthly = buildMonthlySeries(SAMPLE);
    const months = buildMonthGroups(SAMPLE);

    expect(weekly).toHaveLength(3);
    expect(weekly[0]?.startLabel).toBeTruthy();
    // Monthly overview uses calendar month of each day key.
    expect(monthly).toHaveLength(1);
    expect(monthly[0]?.amount).toBe(1590);
    // Money-chart months use Thursday-of-week (legacy), so May-1 week lands in April.
    expect(months.length).toBeGreaterThanOrEqual(2);
    expect(months.flatMap((month) => month.weeks)).toHaveLength(3);
    expect(months.reduce((sum, month) => sum + month.amount, 0)).toBe(1590);
  });

  it('merges current-month replace and rejects empty month', () => {
    const existing = {
      '2026-04-10': day(100),
      '2026-05-01': day(420),
    };
    const incoming = {
      '2026-05-08': day(560),
      '2026-06-01': day(999),
    };

    const { merged, replacedDays } = mergeCurrentMonthStats(existing, incoming, '2026-05');
    expect(replacedDays).toBe(1);
    expect(merged['2026-04-10']).toBeTruthy();
    expect(merged['2026-05-01']).toBeUndefined();
    expect(merged['2026-05-08']?.Deliverable.amount).toBe(560);
    expect(merged['2026-06-01']).toBeUndefined();

    expect(() => mergeCurrentMonthStats(existing, { '2026-06-01': day(1) }, '2026-05')).toThrow(
      /current month/,
    );
  });

  it('labels the clock month the same way the radio does', () => {
    const now = new Date(2026, 7, 14);
    expect(currentMonthKey(now)).toBe('2026-08');
    expect(currentMonthLabel(now)).toBe('August 2026');
  });

  it('builds segment summaries from markers', () => {
    const segments = buildSegmentSummaries(SAMPLE, ['2026-05-08']);
    expect(segments).toHaveLength(2);
    expect(segments[0]?.closed).toBe(true);
    expect(segments[0]?.amount).toBe(980);
    expect(segments[1]?.closed).toBe(false);
    expect(segments[1]?.amount).toBe(610);
  });

  it('counts calendar weeks, not payment dates', () => {
    // 08/06 and 12/06 share the 08/06–14/06 week; 20/06 and 21/06 share 15/06–21/06.
    const stats: Record<string, DayStats> = {
      '2026-06-08': day(100),
      '2026-06-12': day(100),
      '2026-06-20': day(100),
      '2026-06-21': day(100),
      '2026-06-28': day(100),
    };
    const [segment] = buildSegmentSummaries(stats, ['2026-06-28']);
    expect(segment?.weekCount).toBe(3);
  });

  it('counts a single payment date as one week', () => {
    const [segment] = buildSegmentSummaries({ '2026-05-16': day(390) }, ['2026-05-16']);
    expect(segment?.weekCount).toBe(1);
  });
});
