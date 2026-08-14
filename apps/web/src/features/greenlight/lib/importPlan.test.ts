import { describe, expect, it } from 'vitest';

import { calendarWeekForDate, computeTotals } from '@/features/greenlight/lib/aggregate';
import {
  formatImportPlan,
  importPlanHasChanges,
  planGreenlightImport,
} from '@/features/greenlight/lib/importPlan';
import { mergeWeekStats } from '@/features/greenlight/lib/merge';
import { importGreenlightCsv } from '@/features/greenlight/lib/processRows';
import type { DayStats } from '@/features/greenlight/model/types';

import TIME_RECORDS_EXPORT from './fixtures/timerecords-sample.csv?raw';

function day(amount: number): DayStats {
  return { Deliverable: { amount, details: [] }, currency: 'USD' };
}

const FIXTURE = importGreenlightCsv(TIME_RECORDS_EXPORT).stats;
const FIXTURE_TOTAL = 19348.47;

describe('planGreenlightImport (week replace)', () => {
  it('has the fixture total the date-move case depends on', () => {
    expect(computeTotals(FIXTURE).amount).toBeCloseTo(FIXTURE_TOTAL);
  });

  it('lets a backdated April row in while the clock is in August', () => {
    // 2026-04-08 is a Wednesday; its week is Monday 2026-04-06.
    expect(calendarWeekForDate('2026-04-08')?.key).toBe('2026-04-06');

    const existing = {
      '2026-08-03': day(1733.44),
      '2026-07-28': day(1113.4),
    };
    const incoming = { '2026-04-08': day(3882.5) };

    const plan = planGreenlightImport({ existing, incoming });

    expect(plan.seed).toBe(false);
    expect(plan.nextStats['2026-04-08']?.Deliverable.amount).toBe(3882.5);
    expect(plan.nextStats['2026-08-03']).toEqual(existing['2026-08-03']);
    expect(plan.added).toEqual([{ date: '2026-04-08', amount: 3882.5 }]);
    expect(plan.afterTotal - plan.beforeTotal).toBeCloseTo(3882.5);
  });

  it('moves 3882.50 from the June-29 week to the April-6 week without changing the total', () => {
    expect(calendarWeekForDate('2026-07-01')?.key).toBe('2026-06-29');
    expect(calendarWeekForDate('2026-04-08')?.key).toBe('2026-04-06');

    const existing = { ...FIXTURE };
    delete existing['2026-04-08'];
    existing['2026-07-01'] = day(3882.5);
    expect(computeTotals(existing).amount).toBeCloseTo(FIXTURE_TOTAL);

    const plan = planGreenlightImport({ existing, incoming: FIXTURE });

    expect(plan.nextStats['2026-07-01']).toBeUndefined();
    expect(plan.nextStats['2026-04-08']?.Deliverable.amount).toBe(3882.5);
    expect(plan.removed).toContainEqual({ date: '2026-07-01', amount: 3882.5 });
    expect(plan.added).toContainEqual({ date: '2026-04-08', amount: 3882.5 });
    expect(plan.beforeTotal).toBeCloseTo(FIXTURE_TOTAL);
    expect(plan.afterTotal).toBeCloseTo(FIXTURE_TOTAL);
    expect(plan.afterTotal - plan.beforeTotal).toBeCloseTo(0);

    const copy = formatImportPlan(plan, 'en-US');
    expect(copy.removedLine).toContain('01/07');
    expect(copy.removedLine).toContain('$3,882.50');
    expect(copy.headline).toMatch(/no change/i);
  });

  it('leaves a week the CSV does not mention byte-for-byte', () => {
    const incoming = { '2026-08-03': day(1733.44) };
    const plan = planGreenlightImport({ existing: FIXTURE, incoming });

    expect(plan.nextStats['2026-04-17']).toEqual(FIXTURE['2026-04-17']);
    expect(plan.nextStats['2026-04-08']).toEqual(FIXTURE['2026-04-08']);
    expect(plan.nextStats['2026-07-21']).toEqual(FIXTURE['2026-07-21']);
    expect(plan.removed).toEqual([]);
    expect(plan.added).toEqual([]);
  });

  it('rebuilds a mentioned week and announces leftover days disappearing', () => {
    const existing = {
      '2026-07-01': day(3882.5),
      '2026-07-05': day(390),
      '2026-04-17': day(388),
    };
    const incoming = { '2026-07-05': day(390) };
    const plan = planGreenlightImport({ existing, incoming });

    expect(calendarWeekForDate('2026-07-01')?.key).toBe(calendarWeekForDate('2026-07-05')?.key);
    expect(plan.nextStats['2026-07-01']).toBeUndefined();
    expect(plan.nextStats['2026-07-05']?.Deliverable.amount).toBe(390);
    expect(plan.nextStats['2026-04-17']).toEqual(existing['2026-04-17']);
    expect(plan.removed).toEqual([{ date: '2026-07-01', amount: 3882.5 }]);
    expect(importPlanHasChanges(plan)).toBe(true);

    const copy = formatImportPlan(plan, 'en-US');
    expect(copy.removedLine).toBe('1 day disappears (01/07, $3,882.50)');
    expect(copy.headline).toContain('1 week rebuilt');
    expect(copy.headline).toContain('Total $4,660.50 → $778.00 (-$3,882.50)');
  });

  it('lists a new day', () => {
    const plan = planGreenlightImport({
      existing: { '2026-07-05': day(390) },
      incoming: { '2026-07-05': day(390), '2026-07-21': day(2275.14) },
    });

    expect(plan.added).toEqual([{ date: '2026-07-21', amount: 2275.14 }]);
    expect(formatImportPlan(plan, 'en-US').headline).toContain('1 new day');
  });

  it('lists a day whose amount changes', () => {
    const plan = planGreenlightImport({
      existing: { '2026-07-05': day(390) },
      incoming: { '2026-07-05': day(400) },
    });

    expect(plan.changed).toEqual([{ date: '2026-07-05', before: 390, after: 400 }]);
    expect(formatImportPlan(plan, 'en-US').headline).toContain('1 day updates');
  });

  it('says when nothing would change', () => {
    const incoming = {
      '2026-07-05': day(390),
      '2026-07-06': day(1408.42),
    };
    const existing = { ...incoming, '2026-04-17': day(388) };
    const plan = planGreenlightImport({ existing, incoming });

    expect(importPlanHasChanges(plan)).toBe(false);
    expect(plan.nextStats['2026-04-17']).toEqual(existing['2026-04-17']);
    expect(formatImportPlan(plan, 'en-US').headline).toMatch(/no changes/i);
  });
});

describe('mergeWeekStats', () => {
  it('does not touch a week the CSV never names', () => {
    const existing = { '2026-04-17': day(388), '2026-08-03': day(1733.44) };
    const { merged, replacedWeeks } = mergeWeekStats(existing, { '2026-08-03': day(1700) });
    expect(replacedWeeks).toEqual(['2026-08-03']);
    expect(merged['2026-04-17']).toEqual(existing['2026-04-17']);
    expect(merged['2026-08-03']?.Deliverable.amount).toBe(1700);
  });
});
