import { calendarWeekForDate } from '@/features/greenlight/lib/aggregate';
import type { DayStats } from '@/features/greenlight/model/types';

export function weekKeyForDate(dateKey: string): string | null {
  return calendarWeekForDate(dateKey)?.key ?? null;
}

export function weeksInStats(stats: Record<string, DayStats>): Set<string> {
  const weeks = new Set<string>();
  for (const date of Object.keys(stats)) {
    const week = weekKeyForDate(date);
    if (week) weeks.add(week);
  }
  return weeks;
}

/**
 * Rebuild every week the CSV mentions; leave every other week byte-for-byte.
 *
 * TimeRecords routinely backdates Date/Start (measured: 2 of 19 rows, including
 * a 3882.50 row created in July and dated April). A calendar-month replace
 * would drop those rows, or drop the day they left. The payment unit is the
 * Monday–Sunday week, so that is the replace unit.
 *
 * When `existing` is empty this is identical to replace-all — there is nothing
 * to protect. That is the only reason the first import is still called
 * "Replace all": it is a seed, not a different algorithm.
 */
export function mergeWeekStats(
  existing: Record<string, DayStats>,
  incoming: Record<string, DayStats>,
): { merged: Record<string, DayStats>; replacedWeeks: string[] } {
  const incomingWeeks = weeksInStats(incoming);
  const merged: Record<string, DayStats> = {};

  for (const [date, value] of Object.entries(existing || {})) {
    const week = weekKeyForDate(date);
    if (!week || !incomingWeeks.has(week)) merged[date] = value;
  }

  for (const [date, value] of Object.entries(incoming || {})) {
    merged[date] = value;
  }

  return { merged, replacedWeeks: [...incomingWeeks].sort() };
}
