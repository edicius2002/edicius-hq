import { describe, expect, it } from 'vitest';

import {
  formatImportPlan,
  importPlanHasChanges,
  planGreenlightImport,
} from '@/features/greenlight/lib/importPlan';
import type { DayStats } from '@/features/greenlight/model/types';

function day(amount: number): DayStats {
  return { Deliverable: { amount, details: [] }, currency: 'USD' };
}

const JULY: Record<string, DayStats> = {
  '2026-07-01': day(3882.5),
  '2026-07-05': day(390),
  '2026-07-06': day(1408.42),
  '2026-07-21': day(2275.14),
  '2026-07-28': day(1113.4),
};

const JULY_WITHOUT_MOVED_ROW: Record<string, DayStats> = {
  '2026-07-05': day(390),
  '2026-07-06': day(1408.42),
  '2026-07-21': day(2275.14),
  '2026-07-28': day(1113.4),
};

describe('planGreenlightImport', () => {
  it('announces the July 1st row disappearing under current-month replace', () => {
    const plan = planGreenlightImport({
      existing: { ...JULY, '2026-04-17': day(388) },
      incoming: { ...JULY_WITHOUT_MOVED_ROW, '2026-04-08': day(3882.5) },
      replaceMode: 'current-month',
      monthKey: '2026-07',
    });

    expect(plan.emptyMonth).toBe(false);
    expect(plan.removed).toEqual([{ date: '2026-07-01', amount: 3882.5 }]);
    expect(plan.added).toEqual([]);
    expect(plan.changed).toEqual([]);
    expect(plan.beforeTotal).toBeCloseTo(9069.46);
    expect(plan.afterTotal).toBeCloseTo(5186.96);
    expect(plan.afterTotal - plan.beforeTotal).toBeCloseTo(-3882.5);
    // April is out of scope, so the moved 3882.50 does not reappear here.
    expect(plan.nextStats['2026-04-17']?.Deliverable.amount).toBe(388);
    expect(plan.nextStats['2026-07-01']).toBeUndefined();

    const copy = formatImportPlan(plan, 'en-US');
    expect(copy.removedLine).toBe('1 day disappears (01/07, $3,882.50)');
    expect(copy.headline).toBe('Total $9,069.46 → $5,186.96 (-$3,882.50).');
  });

  it('lists a new day', () => {
    const plan = planGreenlightImport({
      existing: { '2026-07-05': day(390) },
      incoming: { '2026-07-05': day(390), '2026-07-21': day(2275.14) },
      replaceMode: 'current-month',
      monthKey: '2026-07',
    });

    expect(plan.added).toEqual([{ date: '2026-07-21', amount: 2275.14 }]);
    expect(importPlanHasChanges(plan)).toBe(true);
    expect(formatImportPlan(plan, 'en-US').headline).toContain('1 new day');
  });

  it('lists a day whose amount changes', () => {
    const plan = planGreenlightImport({
      existing: { '2026-07-05': day(390) },
      incoming: { '2026-07-05': day(400) },
      replaceMode: 'current-month',
      monthKey: '2026-07',
    });

    expect(plan.changed).toEqual([{ date: '2026-07-05', before: 390, after: 400 }]);
    expect(formatImportPlan(plan, 'en-US').headline).toContain('1 day updates');
  });

  it('says when nothing would change', () => {
    const plan = planGreenlightImport({
      existing: JULY_WITHOUT_MOVED_ROW,
      incoming: JULY_WITHOUT_MOVED_ROW,
      replaceMode: 'current-month',
      monthKey: '2026-07',
    });

    expect(importPlanHasChanges(plan)).toBe(false);
    expect(formatImportPlan(plan, 'en-US').headline).toMatch(/no changes/i);
  });

  it('surfaces a current-month miss as a preview, not by throwing', () => {
    const plan = planGreenlightImport({
      existing: JULY,
      incoming: { '2026-04-08': day(3882.5) },
      replaceMode: 'current-month',
      monthKey: '2026-07',
    });

    expect(plan.emptyMonth).toBe(true);
    expect(importPlanHasChanges(plan)).toBe(false);
    expect(formatImportPlan(plan, 'en-US').headline).toBe(
      'The CSV has no records for July 2026. Nothing will change.',
    );
  });
});
