import { describe, expect, it } from 'vitest';

import { calendarWeekForDate } from '@/features/greenlight/lib/aggregate';
import {
  buildSegmentSummaries,
  computeSegmentedTotals,
  normalizeMarkers,
} from '@/features/greenlight/lib/segments';
import type { DayStats } from '@/features/greenlight/model/types';

function day(amount: number): DayStats {
  return { Deliverable: { amount, details: [] }, currency: 'USD' };
}

/**
 * Amounts and dates that reproduce the live billing periods, without personal
 * fields. The large 3882.50 deliverable sits in the 1–6 Jul period, matching
 * the live cards (the TimeRecords CSV Date/Start for that row is 2026-04-08).
 */
const BILLING_STATS: Record<string, DayStats> = {
  '2026-04-17': day(388),
  '2026-04-24': day(731.25),
  '2026-04-30': day(325),
  '2026-05-07': day(260),
  '2026-05-16': day(390),
  '2026-05-29': day(682.5),
  '2026-06-09': day(390),
  '2026-06-12': day(2052.98),
  '2026-06-20': day(1950),
  '2026-06-21': day(10.84),
  '2026-06-28': day(1365),
  '2026-07-01': day(3882.5),
  '2026-07-05': day(390),
  '2026-07-06': day(1408.42),
  '2026-07-21': day(2275.14),
  '2026-07-28': day(1113.4),
  '2026-08-03': day(1733.44),
};

const LEGACY_DAY_MARKERS = ['2026-05-07', '2026-05-16', '2026-06-28', '2026-07-06'];
const WEEK_MARKERS = ['2026-05-04', '2026-05-11', '2026-06-22', '2026-07-06'];

describe('normalizeMarkers (day → week)', () => {
  it('maps the four live day markers onto their Monday week keys, one for one', () => {
    expect(LEGACY_DAY_MARKERS.map((marker) => calendarWeekForDate(marker)?.key)).toEqual(
      WEEK_MARKERS,
    );
    expect(normalizeMarkers(LEGACY_DAY_MARKERS, BILLING_STATS)).toEqual(WEEK_MARKERS);
  });

  it('is idempotent once the keys are already Mondays', () => {
    expect(normalizeMarkers(WEEK_MARKERS, BILLING_STATS)).toEqual(WEEK_MARKERS);
  });

  it('keeps the first marker when two days collapse to the same week', () => {
    // 7 May (Thu) and 8 May (Fri) 2026 share the week of Monday 4 May.
    const stats = { '2026-05-07': day(1), '2026-05-08': day(1) };
    expect(normalizeMarkers(['2026-05-07', '2026-05-08'], stats)).toEqual(['2026-05-04']);
  });

  it('drops a marker whose week is gone from stats', () => {
    expect(normalizeMarkers(['2026-05-16', 42, null], { '2026-04-17': day(388) })).toEqual([]);
  });

  it('drops values that are not date strings', () => {
    expect(normalizeMarkers(['2026-05-16', 42, null], BILLING_STATS)).toEqual(['2026-05-11']);
  });
});

describe('live billing periods (week markers must not move a cent)', () => {
  const expected = [
    { amount: 1704.25, fee: 170.43, net: 1533.83, closed: true },
    { amount: 390, fee: 0, net: 390, closed: true },
    { amount: 6451.32, fee: 645.13, net: 5806.19, closed: true },
    { amount: 5680.92, fee: 568.09, net: 5112.83, closed: true },
    { amount: 5121.98, fee: 512.2, net: 4609.78, closed: false },
  ];

  function assertPeriods(markers: string[]) {
    const segments = buildSegmentSummaries(BILLING_STATS, markers);
    const totals = computeSegmentedTotals(BILLING_STATS, markers);

    expect(segments).toHaveLength(5);
    for (const [index, want] of expected.entries()) {
      expect(segments[index]?.amount).toBeCloseTo(want.amount, 2);
      expect(segments[index]?.fee).toBeCloseTo(want.fee, 2);
      expect(segments[index]?.net).toBeCloseTo(want.net, 2);
      expect(segments[index]?.closed).toBe(want.closed);
    }
    expect(totals.gross).toBeCloseTo(19348.47, 2);
    expect(totals.fee).toBeCloseTo(
      expected.reduce((sum, period) => sum + period.fee, 0),
      2,
    );
  }

  it('keeps the five periods when migrating the stored day keys', () => {
    assertPeriods(normalizeMarkers(LEGACY_DAY_MARKERS, BILLING_STATS));
  });

  it('keeps the five periods when the markers are already week keys', () => {
    assertPeriods(WEEK_MARKERS);
  });
});
