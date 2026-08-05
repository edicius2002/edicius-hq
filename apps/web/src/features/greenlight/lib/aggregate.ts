import type {
  DayStats,
  MonthGroup,
  MonthPoint,
  WeekPoint,
} from '@/features/greenlight/model/types';

type DayRow = {
  date: string;
  amount: number;
  tasks: number;
  currency: string;
};

function toDayRows(stats: Record<string, DayStats>): DayRow[] {
  return Object.entries(stats)
    .map(([date, day]) => ({
      date,
      amount: day.Deliverable.amount,
      tasks: day.Deliverable.tasks,
      currency: day.currency,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

export function calendarWeekForDate(
  dateKey: string,
): { key: string; label: string; startLabel: string; endLabel: string } | null {
  const [year, month, day] = dateKey.split('-').map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (Number.isNaN(date.getTime())) return null;

  const daysSinceMonday = (date.getUTCDay() + 6) % 7;
  const start = new Date(date);
  start.setUTCDate(start.getUTCDate() - daysSinceMonday);
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);

  const short = (item: Date) =>
    `${String(item.getUTCDate()).padStart(2, '0')}/${String(item.getUTCMonth() + 1).padStart(2, '0')}`;

  const startLabel = short(start);
  const endLabel = short(end);
  return {
    key: start.toISOString().slice(0, 10),
    label: `${startLabel}–${endLabel}`,
    startLabel,
    endLabel,
  };
}

function calendarMonthForWeek(weekKey: string): { key: string; label: string } {
  const [year, month, day] = weekKey.split('-').map(Number);
  const thursday = new Date(Date.UTC(year, month - 1, day + 3));
  return {
    key: thursday.toISOString().slice(0, 7),
    label: new Intl.DateTimeFormat('en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(thursday),
  };
}

function calendarMonthForDate(dateKey: string): { key: string; label: string } | null {
  const [year, month] = String(dateKey || '')
    .split('-')
    .map(Number);
  if (!year || !month) return null;
  const date = new Date(Date.UTC(year, month - 1, 15));
  return {
    key: `${year}-${String(month).padStart(2, '0')}`,
    label: new Intl.DateTimeFormat('en-US', {
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date),
  };
}

export function computeTotals(stats: Record<string, DayStats>): {
  amount: number;
  tasks: number;
  currency: string;
} {
  let amount = 0;
  let tasks = 0;
  let currency = 'USD';
  for (const day of Object.values(stats)) {
    amount += day.Deliverable.amount;
    tasks += day.Deliverable.tasks;
    currency = day.currency || currency;
  }
  return { amount, tasks, currency };
}

export function buildWeeklySeries(stats: Record<string, DayStats>): WeekPoint[] {
  const weeks = new Map<string, WeekPoint>();

  for (const row of toDayRows(stats)) {
    const week = calendarWeekForDate(row.date);
    if (!week) continue;
    const existing = weeks.get(week.key);
    if (existing) {
      existing.amount += row.amount;
      existing.tasks += row.tasks;
    } else {
      weeks.set(week.key, {
        key: week.key,
        label: week.label,
        startLabel: week.startLabel,
        endLabel: week.endLabel,
        amount: row.amount,
        tasks: row.tasks,
        currency: row.currency,
      });
    }
  }

  return [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Monthly totals by calendar month of each day key (legacy overview bars). */
export function buildMonthlySeries(stats: Record<string, DayStats>): MonthPoint[] {
  const months = new Map<string, MonthPoint>();

  for (const row of toDayRows(stats)) {
    const month = calendarMonthForDate(row.date);
    if (!month) continue;
    const current = months.get(month.key);
    if (current) {
      current.amount += row.amount;
      current.currency = row.currency || current.currency;
    } else {
      months.set(month.key, {
        key: month.key,
        label: month.label,
        amount: row.amount,
        currency: row.currency,
      });
    }
  }

  return [...months.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Month groups via Thursday-of-week rule (legacy money chart). */
export function buildMonthGroups(stats: Record<string, DayStats>): MonthGroup[] {
  const weeks = buildWeeklySeries(stats);
  const months = new Map<string, MonthGroup>();

  for (const week of weeks) {
    const month = calendarMonthForWeek(week.key);
    const existing = months.get(month.key);
    if (existing) {
      existing.amount += week.amount;
      existing.tasks += week.tasks;
      existing.weeks.push(week);
    } else {
      months.set(month.key, {
        key: month.key,
        label: month.label,
        amount: week.amount,
        tasks: week.tasks,
        currency: week.currency,
        weeks: [week],
      });
    }
  }

  return [...months.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/** Days belonging to a calendar week (for marker placement on last day). */
export function daysInWeek(stats: Record<string, DayStats>, weekKey: string): string[] {
  return toDayRows(stats)
    .filter((row) => calendarWeekForDate(row.date)?.key === weekKey)
    .map((row) => row.date);
}
