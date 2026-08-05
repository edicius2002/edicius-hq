import { shortDate } from '@/features/greenlight/lib/chartFormat';
import { applyPlatformFee } from '@/features/greenlight/lib/fees';
import type { DayStats, SegmentSummaryItem } from '@/features/greenlight/model/types';

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

export function buildSegmentSummaries(
  stats: Record<string, DayStats>,
  markers: string[],
): SegmentSummaryItem[] {
  const rows = toDayRows(stats);
  if (!rows.length || !markers.length) return [];

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

  return segments
    .filter(({ rows: segmentRows }) => segmentRows.length)
    .map(({ rows: segmentRows, closed }) => {
      const amount = segmentRows.reduce((sum, row) => sum + row.amount, 0);
      const tasks = segmentRows.reduce((sum, row) => sum + row.tasks, 0);
      const { fee, net } = applyPlatformFee(amount);
      const first = shortDate(segmentRows[0].date);
      const last = shortDate(segmentRows.at(-1)!.date);
      return {
        rangeLabel: segmentRows.length === 1 ? first : `${first} → ${last}`,
        dayCount: segmentRows.length,
        closed,
        amount,
        fee,
        net,
        tasks,
        currency: segmentRows[0]?.currency || 'USD',
      };
    });
}

export function dateRangeLabel(stats: Record<string, DayStats>): string {
  const keys = Object.keys(stats).sort();
  if (!keys.length) return 'No data';
  return `${keys[0]} → ${keys.at(-1)}`;
}
