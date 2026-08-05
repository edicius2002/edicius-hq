import { describe, expect, it } from 'vitest';

import { extractTaskBreakdown, importGreenlightCsv } from '@/features/greenlight/lib/processRows';
import { buildWeeklySeries, computeTotals } from '@/features/greenlight/lib/aggregate';

const SAMPLE_CSV = `Date,Record Type,Amount,Currency,Notes
2026-05-04,Deliverable,1000,USD,"Attempter: 2
Reviewer: 1"
2026-05-05,Entregable,"1,500.50",USD,Total Delivered Tasks: 4
2026-05-06,Expense,999,USD,should be ignored
2026-05-11,Deliverable,500,USD,Attempter: 1
`;

describe('Greenlight CSV import', () => {
  it('imports deliverable rows with ES/EN aliases and aggregates by day', () => {
    const result = importGreenlightCsv(SAMPLE_CSV);

    expect(result.rowsRead).toBe(4);
    expect(result.daysGenerated).toBe(3);
    expect(result.stats['2026-05-04']?.Deliverable).toMatchObject({
      amount: 1000,
      attempter: 2,
      reviewer: 1,
      tasks: 3,
    });
    expect(result.stats['2026-05-05']?.Deliverable).toMatchObject({
      amount: 1500.5,
      attempter: 4,
      reviewer: 0,
      tasks: 4,
    });
    expect(result.stats['2026-05-06']).toBeUndefined();
  });

  it('computes totals and weekly series', () => {
    const { stats } = importGreenlightCsv(SAMPLE_CSV);
    const totals = computeTotals(stats);
    const weekly = buildWeeklySeries(stats);

    expect(totals.amount).toBeCloseTo(3000.5);
    expect(totals.tasks).toBe(8);
    expect(weekly.length).toBeGreaterThanOrEqual(2);
    expect(weekly[0]?.amount).toBeCloseTo(2500.5);
  });

  it('parses task breakdown from notes', () => {
    expect(extractTaskBreakdown('Attempter: 3 Reviewer: 2')).toEqual({
      attempter: 3,
      reviewer: 2,
    });
    expect(extractTaskBreakdown('Total Delivered Tasks: 9')).toEqual({
      attempter: 9,
      reviewer: 0,
    });
  });

  it('rejects CSV without deliverable rows', () => {
    expect(() => importGreenlightCsv(`Date,Record Type,Amount\n2026-01-01,Expense,10\n`)).toThrow(
      /Deliverable\/Entregable/,
    );
  });
});
