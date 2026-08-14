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

function weekKeyForDate(date: string): string | null {
  return calendarWeekForDate(date)?.key ?? null;
}

function weekKeysFromStats(stats: Record<string, DayStats>): Set<string> {
  const weeks = new Set<string>();
  for (const date of Object.keys(stats)) {
    const week = weekKeyForDate(date);
    if (week) weeks.add(week);
  }
  return weeks;
}

/**
 * Stored markers are week keys (the Monday `calendarWeekForDate` returns).
 * Older documents stored a payment day; those are mapped to their week.
 *
 * Two markers that land in the same week collapse to one — first wins.
 * A week is one cut. Markers whose week is gone from `stats` are dropped so
 * they cannot keep "Clear markers" alive after the week has disappeared.
 */
export function normalizeMarkers(raw: unknown, stats: Record<string, DayStats>): string[] {
  if (!Array.isArray(raw)) return [];
  const present = weekKeysFromStats(stats);
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') continue;
    const week = weekKeyForDate(value);
    if (!week || seen.has(week) || !present.has(week)) continue;
    seen.add(week);
    result.push(week);
  }
  return result;
}

function markerWeekKeys(markers: string[], presentWeeks: Set<string>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const marker of markers) {
    const week = weekKeyForDate(marker);
    if (!week || seen.has(week) || !presentWeeks.has(week)) continue;
    seen.add(week);
    result.push(week);
  }
  return result.sort();
}

/** Map each day key to a segment index; index increments after a marked week. */
export function markerSegmentsForDays(
  dayKeys: string[],
  markers: string[],
): { byDay: Map<string, number>; hasMarkers: boolean } {
  const presentWeeks = new Set(
    dayKeys.map((day) => weekKeyForDate(day)).filter((week): week is string => Boolean(week)),
  );
  const validMarkers = new Set(markerWeekKeys(markers, presentWeeks));
  const byDay = new Map<string, number>();
  let segment = 0;

  for (let index = 0; index < dayKeys.length; index += 1) {
    const day = dayKeys[index];
    byDay.set(day, segment);
    const week = weekKeyForDate(day);
    const nextWeek = index + 1 < dayKeys.length ? weekKeyForDate(dayKeys[index + 1]) : null;
    if (week && validMarkers.has(week) && week !== nextWeek) segment += 1;
  }

  return { byDay, hasMarkers: validMarkers.size > 0 };
}

/** Distinct calendar weeks touched, since a single week can carry several payment dates. */
function countWeeks(rows: DayRow[]): number {
  const weeks = new Set<string>();
  for (const row of rows) {
    const week = weekKeyForDate(row.date);
    if (week) weeks.add(week);
  }
  return weeks.size;
}

/**
 * Split the days into the periods delimited by week markers. A marker closes
 * after the last payment day of that week. With no markers the whole range is
 * a single open period, which is what makes the fee threshold behave the same
 * whether or not the user has split anything yet.
 */
function splitByMarkers(rows: DayRow[], markers: string[]): { rows: DayRow[]; closed: boolean }[] {
  const presentWeeks = new Set(
    rows.map((row) => weekKeyForDate(row.date)).filter((week): week is string => Boolean(week)),
  );
  const validMarkers = markerWeekKeys(markers, presentWeeks);

  const segments: { rows: DayRow[]; closed: boolean }[] = [];
  let start = 0;

  for (const weekKey of validMarkers) {
    let lastIndex = -1;
    for (let index = start; index < rows.length; index += 1) {
      if (weekKeyForDate(rows[index].date) === weekKey) lastIndex = index;
    }
    if (lastIndex < start) continue;
    segments.push({ rows: rows.slice(start, lastIndex + 1), closed: true });
    start = lastIndex + 1;
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
