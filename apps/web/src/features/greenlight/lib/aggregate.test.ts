import { describe, expect, it } from 'vitest';

import {
  buildMonthGroups,
  buildMonthlySeries,
  buildWeeklySeries,
} from '@/features/greenlight/lib/aggregate';
import { importGreenlightCsv } from '@/features/greenlight/lib/processRows';
import { buildSegmentSummaries } from '@/features/greenlight/lib/segments';
import type { DayStats } from '@/features/greenlight/model/types';

import TIME_RECORDS_EXPORT from './fixtures/timerecords-sample.csv?raw';

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

describe('Greenlight aggregation (Thursday-of-week months)', () => {
  it('puts the same week in the same month on both charts', () => {
    const weekly = buildWeeklySeries(SAMPLE);
    const monthly = buildMonthlySeries(SAMPLE);
    const months = buildMonthGroups(SAMPLE);

    expect(weekly).toHaveLength(3);
    expect(weekly[0]?.startLabel).toBeTruthy();

    // May 1 2026 is a Friday. Its week is Mon 27 Apr – Sun 3 May; Thursday is
    // 30 Apr, so the whole week belongs to April. The overview bars used to
    // assign by calendar day and put that $420 in May, while Weeks put it in
    // April — two totals for one month. Payment is weekly Mon–Sun, so the week
    // is the unit and both views now follow the Thursday.
    expect(monthly.map((point) => point.key)).toEqual(months.map((month) => month.key));
    expect(monthly).toHaveLength(2);
    expect(monthly[0]).toMatchObject({ key: '2026-04', amount: 420 });
    expect(monthly[1]).toMatchObject({ key: '2026-05', amount: 1170 });
    expect(months.flatMap((month) => month.weeks)).toHaveLength(3);
    expect(months.reduce((sum, month) => sum + month.amount, 0)).toBe(1590);
  });

  it('counts a Monday-in-August week as September when Thursday is in September', () => {
    // Week Mon 31 Aug – Sun 6 Sep 2026; Thursday is 3 Sep.
    const stats = { '2026-08-31': day(100) };
    const monthly = buildMonthlySeries(stats);
    const months = buildMonthGroups(stats);

    expect(monthly).toHaveLength(1);
    expect(monthly[0]?.key).toBe('2026-09');
    expect(monthly[0]?.amount).toBe(100);
    expect(months[0]?.key).toBe('2026-09');
  });

  it('keeps the TimeRecords fixture month totals under the unified rule', () => {
    const { stats } = importGreenlightCsv(TIME_RECORDS_EXPORT);
    const monthly = buildMonthlySeries(stats);
    const grouped = buildMonthGroups(stats);
    const byKey = Object.fromEntries(monthly.map((point) => [point.key, point.amount]));

    expect(byKey['2026-04']).toBeCloseTo(5326.75);
    expect(byKey['2026-05']).toBeCloseTo(1332.5);
    expect(byKey['2026-06']).toBeCloseTo(5768.82);
    expect(byKey['2026-07']).toBeCloseTo(5186.96);
    expect(byKey['2026-08']).toBeCloseTo(1733.44);
    expect(monthly.map((point) => point.key)).toEqual(grouped.map((month) => month.key));
    expect(monthly.map((point) => point.amount)).toEqual(grouped.map((month) => month.amount));
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
