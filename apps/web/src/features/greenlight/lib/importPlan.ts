import { calendarWeekForDate } from '@/features/greenlight/lib/aggregate';
import { shortDate } from '@/features/greenlight/lib/chartFormat';
import { mergeWeekStats } from '@/features/greenlight/lib/merge';
import type { DayStats } from '@/features/greenlight/model/types';
import { formatMoney } from '@/shared/lib/money';

export type ImportDayAdd = { date: string; amount: number };
export type ImportDayChange = { date: string; before: number; after: number };
export type ImportDayRemove = { date: string; amount: number };

export type ImportPlan = {
  /** True when there is nothing stored — the Replace-all seed, not a merge. */
  seed: boolean;
  replacedWeeks: string[];
  nextStats: Record<string, DayStats>;
  added: ImportDayAdd[];
  changed: ImportDayChange[];
  removed: ImportDayRemove[];
  /** Whole document, not just the weeks being rebuilt. */
  beforeTotal: number;
  afterTotal: number;
  currency: string;
};

function amountOf(day: DayStats | undefined): number {
  return day?.Deliverable.amount ?? 0;
}

function sumAll(stats: Record<string, DayStats>): number {
  return Object.values(stats).reduce((sum, day) => sum + amountOf(day), 0);
}

function currencyOf(stats: Record<string, DayStats>, fallback = 'USD'): string {
  for (const day of Object.values(stats)) {
    if (day.currency) return day.currency;
  }
  return fallback;
}

function inReplacedWeeks(date: string, weeks: Set<string>): boolean {
  const week = calendarWeekForDate(date)?.key;
  return Boolean(week && weeks.has(week));
}

/**
 * What applying this CSV would do to `existing`. Does not write.
 *
 * Day diffs are scoped to weeks the CSV mentions. Totals are the whole
 * document, because a backdated row moving week is a no-loss swap only if
 * you look at the full sum. Headline names how many weeks are rebuilt;
 * disappearing days stay on their own highlighted line — they are the
 * dangerous bit, not a grey bullet next to "new day".
 */
export function planGreenlightImport({
  existing,
  incoming,
}: {
  existing: Record<string, DayStats>;
  incoming: Record<string, DayStats>;
}): ImportPlan {
  const seed = Object.keys(existing).length === 0;
  const { merged: nextStats, replacedWeeks } = mergeWeekStats(existing, incoming);
  const weekSet = new Set(replacedWeeks);

  const existingDates = Object.keys(existing)
    .filter((date) => inReplacedWeeks(date, weekSet))
    .sort();
  const nextDates = Object.keys(nextStats)
    .filter((date) => inReplacedWeeks(date, weekSet))
    .sort();
  const existingSet = new Set(existingDates);
  const nextSet = new Set(nextDates);

  const added: ImportDayAdd[] = [];
  const changed: ImportDayChange[] = [];
  const removed: ImportDayRemove[] = [];

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

  return {
    seed,
    replacedWeeks,
    nextStats,
    added,
    changed,
    removed,
    beforeTotal: sumAll(existing),
    afterTotal: sumAll(nextStats),
    currency: currencyOf(nextStats, currencyOf(existing)),
  };
}

export function importPlanHasChanges(plan: ImportPlan): boolean {
  return plan.added.length > 0 || plan.changed.length > 0 || plan.removed.length > 0;
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
export function formatImportPlan(
  plan: ImportPlan,
  locale?: string,
): {
  headline: string;
  removedLine: string | null;
} {
  const { currency } = plan;

  if (!importPlanHasChanges(plan)) {
    return {
      headline: plan.seed
        ? 'No changes. The CSV is empty of deliverable days.'
        : 'No changes. This CSV matches the stored days of the weeks it mentions.',
      removedLine: null,
    };
  }

  const other: string[] = [];
  if (!plan.seed && plan.replacedWeeks.length) {
    other.push(countPhrase(plan.replacedWeeks.length, 'week rebuilt', 'weeks rebuilt'));
  }
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
