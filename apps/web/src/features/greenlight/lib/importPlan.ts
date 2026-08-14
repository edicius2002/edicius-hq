import { shortDate } from '@/features/greenlight/lib/chartFormat';
import { currentMonthKey, dateInMonth, mergeCurrentMonthStats } from '@/features/greenlight/lib/merge';
import type { DayStats, ReplaceMode } from '@/features/greenlight/model/types';
import { formatMoney } from '@/shared/lib/money';

export type ImportDayAdd = { date: string; amount: number };
export type ImportDayChange = { date: string; before: number; after: number };
export type ImportDayRemove = { date: string; amount: number };

export type ImportPlan = {
  replaceMode: ReplaceMode;
  monthKey: string;
  emptyMonth: boolean;
  nextStats: Record<string, DayStats>;
  added: ImportDayAdd[];
  changed: ImportDayChange[];
  removed: ImportDayRemove[];
  beforeTotal: number;
  afterTotal: number;
  currency: string;
};

function amountOf(day: DayStats | undefined): number {
  return day?.Deliverable.amount ?? 0;
}

function sumAmounts(stats: Record<string, DayStats>, dates: string[]): number {
  return dates.reduce((sum, date) => sum + amountOf(stats[date]), 0);
}

function currencyOf(stats: Record<string, DayStats>, fallback = 'USD'): string {
  for (const day of Object.values(stats)) {
    if (day.currency) return day.currency;
  }
  return fallback;
}

/**
 * What applying this CSV would do to `existing`, in the selected replace mode.
 * Does not write. `emptyMonth` is the current-month miss — a preview message,
 * not an exception.
 */
export function planGreenlightImport({
  existing,
  incoming,
  replaceMode,
  monthKey = currentMonthKey(),
}: {
  existing: Record<string, DayStats>;
  incoming: Record<string, DayStats>;
  replaceMode: ReplaceMode;
  monthKey?: string;
}): ImportPlan {
  const inScope = (date: string) =>
    replaceMode === 'all' ? true : dateInMonth(date, monthKey);

  let nextStats: Record<string, DayStats>;
  let emptyMonth = false;

  if (replaceMode === 'current-month') {
    const { merged, replacedDays } = mergeCurrentMonthStats(existing, incoming, monthKey);
    emptyMonth = replacedDays === 0;
    nextStats = emptyMonth ? existing : merged;
  } else {
    nextStats = incoming;
  }

  const existingDates = Object.keys(existing).filter(inScope).sort();
  const nextDates = Object.keys(nextStats).filter(inScope).sort();
  const existingSet = new Set(existingDates);
  const nextSet = new Set(nextDates);

  const added: ImportDayAdd[] = [];
  const changed: ImportDayChange[] = [];
  const removed: ImportDayRemove[] = [];

  if (!emptyMonth) {
    for (const date of nextDates) {
      if (!existingSet.has(date)) {
        added.push({ date, amount: amountOf(nextStats[date]) });
      } else if (amountOf(existing[date]) !== amountOf(nextStats[date])) {
        changed.push({
          date,
          before: amountOf(existing[date]),
          after: amountOf(nextStats[date]),
        });
      }
    }
    for (const date of existingDates) {
      if (!nextSet.has(date)) {
        removed.push({ date, amount: amountOf(existing[date]) });
      }
    }
  }

  return {
    replaceMode,
    monthKey,
    emptyMonth,
    nextStats,
    added,
    changed,
    removed,
    beforeTotal: sumAmounts(existing, existingDates),
    afterTotal: emptyMonth ? sumAmounts(existing, existingDates) : sumAmounts(nextStats, nextDates),
    currency: currencyOf(nextStats, currencyOf(existing)),
  };
}

export function importPlanHasChanges(plan: ImportPlan): boolean {
  return !plan.emptyMonth && (plan.added.length > 0 || plan.changed.length > 0 || plan.removed.length > 0);
}

function countPhrase(count: number, one: string, many: string): string {
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function formatDelta(delta: number, currency: string, locale?: string): string {
  if (delta === 0) return 'no change';
  if (delta > 0) return `+${formatMoney(delta, currency, locale)}`;
  return formatMoney(delta, currency, locale);
}

function formatRemoved(removed: ImportDayRemove[], currency: string, locale?: string): string {
  const details = removed
    .map((day) => `${shortDate(day.date)}, ${formatMoney(day.amount, currency, locale)}`)
    .join('; ');
  return `${countPhrase(removed.length, 'day disappears', 'days disappear')} (${details})`;
}

/** One-glance copy for the confirm panel. Pass a locale in tests. */
export function formatImportPlan(plan: ImportPlan, locale?: string): {
  headline: string;
  removedLine: string | null;
} {
  const { currency } = plan;

  if (plan.emptyMonth) {
    const month = new Intl.DateTimeFormat(locale ?? 'en-US', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(new Date(`${plan.monthKey}-15T00:00:00.000Z`));
    return {
      headline: `The CSV has no records for ${month}. Nothing will change.`,
      removedLine: null,
    };
  }

  if (!importPlanHasChanges(plan)) {
    return {
      headline: 'No changes. This CSV matches the stored days this mode would replace.',
      removedLine: null,
    };
  }

  const other: string[] = [];
  if (plan.added.length) {
    other.push(countPhrase(plan.added.length, 'new day', 'new days'));
  }
  if (plan.changed.length) {
    other.push(countPhrase(plan.changed.length, 'day updates', 'days update'));
  }

  const delta = plan.afterTotal - plan.beforeTotal;
  const totals = `Total ${formatMoney(plan.beforeTotal, currency, locale)} → ${formatMoney(plan.afterTotal, currency, locale)} (${formatDelta(delta, currency, locale)})`;
  const removedLine = plan.removed.length ? formatRemoved(plan.removed, currency, locale) : null;
  const headline = other.length ? `${other.join(' · ')}. ${totals}.` : `${totals}.`;

  return { headline, removedLine };
}
