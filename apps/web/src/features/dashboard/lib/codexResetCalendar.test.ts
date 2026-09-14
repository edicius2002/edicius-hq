import { describe, expect, it } from 'vitest';

import type { CodexReset } from '@/shared/api/codexResets';

import { bogotaDateKey, buildResetCalendar, formatBogotaDateTime } from './codexResetCalendar';

function reset(id: string, announcedAt: string, resetType: 'regular' | 'banked'): CodexReset {
  return {
    id,
    announcedAt,
    resetType,
    text: `Reset ${id}`,
    source: { type: 'x_post', author: 'thsottiaux', url: `https://x.com/${id}` },
  };
}

describe('Bogotá reset calendar', () => {
  it('assigns UTC instants to the correct civil day across midnight in GMT-5', () => {
    expect(bogotaDateKey('2026-09-02T04:59:59Z')).toBe('2026-09-01');
    expect(bogotaDateKey('2026-09-02T05:00:00Z')).toBe('2026-09-02');
    expect(formatBogotaDateTime('2026-09-02T04:59:59Z')).toContain('Sep 1, 2026');
    expect(formatBogotaDateTime('2026-09-02T04:59:59Z')).toContain('GMT-5');
  });

  it('builds 53 Sunday-aligned weeks and distinguishes regular, banked and future days', () => {
    const calendar = buildResetCalendar(
      [
        reset('regular', '2026-09-12T04:30:00Z', 'regular'),
        reset('banked', '2026-09-12T05:30:00Z', 'banked'),
      ],
      new Date('2026-09-14T15:00:00Z'),
    );

    expect(calendar.weeks).toHaveLength(53);
    expect(calendar.weeks[0]).toHaveLength(7);
    expect(calendar.weeks[0][0].date.getUTCDay()).toBe(0);
    expect(calendar.weeks.flat().find((day) => day.key === '2026-09-11')?.resetType).toBe(
      'regular',
    );
    expect(calendar.weeks.flat().find((day) => day.key === '2026-09-12')?.resetType).toBe('banked');
    expect(calendar.weeks.flat().find((day) => day.key === '2026-09-15')?.future).toBe(true);
    expect(
      calendar.monthLabels.some((month, index, labels) => labels[index - 1]?.label === month.label),
    ).toBe(false);
  });
});
