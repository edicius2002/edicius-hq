import type {
  DayStats,
  MonthGroup,
  MonthPoint,
  WeekPoint,
} from '@/features/greenlight/model/types';

type DayRow = {
  date: string;
  amount: number;
  currency: string;
};

function toDayRows(stats: Record<string, DayStats>): DayRow[] {
  return Object.entries(stats)
    .map(([date, day]) => ({
      date,
      amount: day.Deliverable.amount,
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

function shortMonthLabel(monthKey: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${monthKey}-15T00:00:00.000Z`));
}

export function computeTotals(stats: Record<string, DayStats>): {
  amount: number;
  currency: string;
} {
  let amount = 0;
  let currency = 'USD';
  for (const day of Object.values(stats)) {
    amount += day.Deliverable.amount;
    currency = day.currency || currency;
  }
  return { amount, currency };
}

export function buildWeeklySeries(stats: Record<string, DayStats>): WeekPoint[] {
  const weeks = new Map<string, WeekPoint>();

  for (const row of toDayRows(stats)) {
    const week = calendarWeekForDate(row.date);
    if (!week) continue;
    const existing = weeks.get(week.key);
    if (existing) {
      existing.amount += row.amount;
    } else {
      weeks.set(week.key, {
        key: week.key,
        label: week.label,
        startLabel: week.startLabel,
        endLabel: week.endLabel,
        amount: row.amount,
        currency: row.currency,
      });
    }
  }

  return [...weeks.values()].sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Monthly totals by Thursday-of-week — the same grouping as the Weeks chart.
 * A week is the payment unit (Mon–Sun); splitting it across calendar months
 * would invent a cut the client does not make.
 */
export function buildMonthlySeries(stats: Record<string, DayStats>): MonthPoint[] {
  return buildMonthGroupsFromWeeks(buildWeeklySeries(stats)).map((month) => ({
    key: month.key,
    label: shortMonthLabel(month.key),
    amount: month.amount,
    currency: month.currency,
  }));
}

/** Month groups via Thursday-of-week — same rule as `buildMonthlySeries`. */
export function buildMonthGroupsFromWeeks(weeks: WeekPoint[]): MonthGroup[] {
  const months = new Map<string, MonthGroup>();

  for (const week of weeks) {
    const month = calendarMonthForWeek(week.key);
    const existing = months.get(month.key);
    if (existing) {
      existing.amount += week.amount;
      existing.weeks.push(week);
    } else {
      months.set(month.key, {
        key: month.key,
        label: month.label,
        amount: week.amount,
        currency: week.currency,
        weeks: [week],
      });
    }
  }

  return [...months.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function buildMonthGroups(stats: Record<string, DayStats>): MonthGroup[] {
  return buildMonthGroupsFromWeeks(buildWeeklySeries(stats));
}

/** Days belonging to a calendar week (for marker placement on last day). */
export function daysInWeek(stats: Record<string, DayStats>, weekKey: string): string[] {
  return toDayRows(stats)
    .filter((row) => calendarWeekForDate(row.date)?.key === weekKey)
    .map((row) => row.date);
}
