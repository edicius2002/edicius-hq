import { describe, expect, it } from 'vitest';

import { importGreenlightCsv } from '@/features/greenlight/lib/processRows';
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
    expect(result.stats['2026-05-04']?.Deliverable).toMatchObject({ amount: 1000 });
    expect(result.stats['2026-05-05']?.Deliverable).toMatchObject({ amount: 1500.5 });
    expect(result.stats['2026-05-06']).toBeUndefined();
  });

  it('keeps no per-day task counters', () => {
    const { stats } = importGreenlightCsv(SAMPLE_CSV);
    expect(Object.keys(stats['2026-05-04'].Deliverable).sort()).toEqual(['amount', 'details']);
  });

  it('computes totals and weekly series', () => {
    const { stats } = importGreenlightCsv(SAMPLE_CSV);
    const totals = computeTotals(stats);
    const weekly = buildWeeklySeries(stats);

    expect(totals.amount).toBeCloseTo(3000.5);
    expect(weekly.length).toBeGreaterThanOrEqual(2);
    expect(weekly[0]?.amount).toBeCloseTo(2500.5);
  });

  it('imports TimeRecords-style headers with Date/Start', () => {
    const csv = `Parent Client,Record Type,Date/Start,Amount,Currency,Notes
X,Deliverable,2026-07-28T00:00,1083.4,USD,"NES-COD-R-54|1074, 1051 |"
X,Expense,2026-07-28T00:00,30,USD,ignore
X,Deliverable,2026-07-21T00:00,2275.14,USD,|
`;
    const result = importGreenlightCsv(csv);
    expect(result.daysGenerated).toBe(2);
    expect(result.stats['2026-07-28']?.Deliverable.amount).toBeCloseTo(1083.4);
    expect(result.stats['2026-07-21']?.Deliverable.amount).toBeCloseTo(2275.14);
  });

  it('rejects CSV without deliverable rows', () => {
    expect(() => importGreenlightCsv(`Date,Record Type,Amount\n2026-01-01,Expense,10\n`)).toThrow(
      /Deliverable\/Entregable/,
    );
  });
});
