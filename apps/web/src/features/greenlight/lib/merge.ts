import type { DayStats } from '@/features/greenlight/model/types';

export function currentMonthKey(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/** Clock month, for the replace-mode radio — same instant as `currentMonthKey`. */
export function currentMonthLabel(now = new Date()): string {
  return new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric' }).format(now);
}

export function dateInMonth(dateKey: string, monthKey: string): boolean {
  return String(dateKey || '').startsWith(`${monthKey}-`) || String(dateKey || '') === monthKey;
}

export function mergeCurrentMonthStats(
  existing: Record<string, DayStats>,
  incoming: Record<string, DayStats>,
  monthKey: string,
): { merged: Record<string, DayStats>; replacedDays: number } {
  const merged: Record<string, DayStats> = {};
  for (const [date, value] of Object.entries(existing || {})) {
    if (!dateInMonth(date, monthKey)) merged[date] = value;
  }

  let replacedDays = 0;
  for (const [date, value] of Object.entries(incoming || {})) {
    if (!dateInMonth(date, monthKey)) continue;
    merged[date] = value;
    replacedDays += 1;
  }

  return { merged, replacedDays };
}
