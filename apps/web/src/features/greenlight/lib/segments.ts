import { calendarWeekForDate } from '@/features/greenlight/lib/aggregate';
import { shortDate } from '@/features/greenlight/lib/chartFormat';
import { applyPlatformFee } from '@/features/greenlight/lib/fees';
import type { DayStats, SegmentSummaryItem } from '@/features/greenlight/model/types';

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

/** Map each day key to a segment index; index increments after a marked day. */
export function markerSegmentsForDays(
  dayKeys: string[],
  markers: string[],
): { byDay: Map<string, number>; hasMarkers: boolean } {
  const validMarkers = new Set(markers.filter((day) => dayKeys.includes(day)));
  const byDay = new Map<string, number>();
  let segment = 0;
  for (const day of dayKeys) {
    byDay.set(day, segment);
    if (validMarkers.has(day)) segment += 1;
  }
  return { byDay, hasMarkers: validMarkers.size > 0 };
}

/** Distinct calendar weeks touched, since a single week can carry several payment dates. */
function countWeeks(rows: DayRow[]): number {
  const weeks = new Set<string>();
  for (const row of rows) {
    const week = calendarWeekForDate(row.date);
    if (week) weeks.add(week.key);
  }
  return weeks.size;
}

/**
 * Split the days into the periods delimited by markers. With no markers the
 * whole range is a single open period, which is what makes the fee threshold
 * behave the same whether or not the user has split anything yet.
 */
function splitByMarkers(rows: DayRow[], markers: string[]): { rows: DayRow[]; closed: boolean }[] {
  const validMarkers = [...markers].filter((day) => rows.some((row) => row.date === day)).sort();

  const segments: { rows: DayRow[]; closed: boolean }[] = [];
  let start = 0;

  for (const markerDay of validMarkers) {
    const index = rows.findIndex((row) => row.date === markerDay);
    if (index < start) continue;
    segments.push({ rows: rows.slice(start, index + 1), closed: true });
    start = index + 1;
  }

  if (start < rows.length) {
    segments.push({ rows: rows.slice(start), closed: false });
  }

  return segments.filter(({ rows: segmentRows }) => segmentRows.length);
}

/**
 * Totals for the whole dataset, charged the way the segments are: the fee
 * threshold applies per marker period, so a period under the minimum keeps its
 * full gross. Without markers this is one period and matches a plain 10%.
 */
export function computeSegmentedTotals(
  stats: Record<string, DayStats>,
  markers: string[],
): { gross: number; fee: number; net: number; charged: boolean } {
  const segments = splitByMarkers(toDayRows(stats), markers);

  let gross = 0;
  let fee = 0;
  for (const { rows } of segments) {
    const amount = rows.reduce((sum, row) => sum + row.amount, 0);
    gross += amount;
    fee += applyPlatformFee(amount).fee;
  }

  return { gross, fee, net: gross - fee, charged: fee > 0 };
}

export function buildSegmentSummaries(
  stats: Record<string, DayStats>,
  markers: string[],
): SegmentSummaryItem[] {
  const rows = toDayRows(stats);
  if (!rows.length || !markers.length) return [];

  return splitByMarkers(rows, markers).map(({ rows: segmentRows, closed }) => {
    const amount = segmentRows.reduce((sum, row) => sum + row.amount, 0);
    const { fee, net, charged } = applyPlatformFee(amount);
    const first = shortDate(segmentRows[0].date);
    const last = shortDate(segmentRows.at(-1)!.date);
    return {
      rangeLabel: segmentRows.length === 1 ? first : `${first} → ${last}`,
      weekCount: countWeeks(segmentRows),
      closed,
      amount,
      fee,
      net,
      feeCharged: charged,
      currency: segmentRows[0]?.currency || 'USD',
    };
  });
}

export function dateRangeLabel(stats: Record<string, DayStats>): string {
  const keys = Object.keys(stats).sort();
  if (!keys.length) return 'No data';
  return `${keys[0]} → ${keys.at(-1)}`;
}
