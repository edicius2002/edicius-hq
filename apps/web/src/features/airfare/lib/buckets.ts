import { cheapestOffer, median } from '@/features/airfare/lib/series';
import type { FarePricePoint, FareSnapshot } from '@/shared/api/fares';

/**
 * Observations gathered into periods, so a month of half-hourly polling can be
 * read as a month.
 *
 * Each period reports a band and a middle rather than a single number. The
 * measurement is why: a route's cheapest fare and the spread of its board move
 * for different reasons, and a day where the expensive itineraries sold out
 * looks identical to a quiet day if all you plot is the minimum.
 */

export type Granularity = 'day' | 'week' | 'month';

export type Bucket = {
  /** `2026-08-18`, `2026-W34`, `2026-08` — sortable as a string in all three. */
  key: string;
  /** What to print on an axis. */
  label: string;
  low: number;
  high: number;
  middle: number;
  /** How many observations landed in this period. */
  count: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * ISO week, because a week that starts on Sunday in one place and Monday in
 * another is not a unit anyone can compare.
 *
 * Built from the `YYYY-MM-DD` prefix only. `capturedAt` is UTC with an offset,
 * and re-parsing it into local time would shuffle observations near midnight
 * into the neighbouring day for readers far enough from Greenwich.
 */
export function isoWeekKey(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  if (!year || !month || !day) return date;
  const utc = Date.UTC(year, month - 1, day);
  const weekday = (new Date(utc).getUTCDay() + 6) % 7; // Monday = 0
  const thursday = utc + (3 - weekday) * DAY_MS;
  const isoYear = new Date(thursday).getUTCFullYear();
  const firstThursday = Date.UTC(isoYear, 0, 4);
  const firstWeekday = (new Date(firstThursday).getUTCDay() + 6) % 7;
  const week = Math.round((thursday - (firstThursday - firstWeekday * DAY_MS)) / (7 * DAY_MS)) + 1;
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function bucketKey(capturedAt: string, granularity: Granularity): string {
  const date = capturedAt.slice(0, 10);
  if (granularity === 'day') return date;
  if (granularity === 'month') return date.slice(0, 7);
  return isoWeekKey(date);
}

function labelFor(key: string, granularity: Granularity): string {
  if (granularity === 'month') return key;
  if (granularity === 'week') return key.replace('-W', ' wk ');
  return key.slice(5); // MM-DD; the year is on the axis, not on every tick
}

function summarise(key: string, granularity: Granularity, prices: number[]): Bucket {
  return {
    key,
    label: labelFor(key, granularity),
    low: Math.min(...prices),
    high: Math.max(...prices),
    // Median rather than mean: one collection during a fare glitch should not
    // drag a whole week's middle with it.
    middle: median(prices),
    count: prices.length,
  };
}

/**
 * Our own observations, gathered into periods.
 *
 * The price taken from each snapshot is its cheapest offer, so `low` and
 * `high` are the range of *the cheapest fare over the period* — not the range
 * of every itinerary on the board. Those are different questions, and this one
 * is the one the series has always answered.
 */
export function bucketSnapshots(snapshots: FareSnapshot[], granularity: Granularity): Bucket[] {
  const groups = new Map<string, number[]>();
  for (const snapshot of snapshots) {
    const offer = cheapestOffer(snapshot);
    if (!offer) continue;
    const key = bucketKey(snapshot.capturedAt, granularity);
    const prices = groups.get(key);
    if (prices) prices.push(offer.price);
    else groups.set(key, [offer.price]);
  }
  return [...groups.entries()]
    .map(([key, prices]) => summarise(key, granularity, prices))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The provider's own daily history, gathered the same way.
 *
 * Kept in its own function and its own series because it is one rounded
 * integer per day with no airline and no departure time. At day granularity it
 * can only ever be a line — a single value has no band — which is exactly why
 * it is drawn behind ours rather than merged into it.
 */
export function bucketBaseline(points: FarePricePoint[], granularity: Granularity): Bucket[] {
  const groups = new Map<string, number[]>();
  for (const point of points) {
    const key = bucketKey(point.date, granularity);
    const prices = groups.get(key);
    if (prices) prices.push(point.price);
    else groups.set(key, [point.price]);
  }
  return [...groups.entries()]
    .map(([key, prices]) => summarise(key, granularity, prices))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Every price either series puts on the chart, for scaling the axis to both. */
export function spanOf(...series: Bucket[][]): { low: number; high: number } | null {
  const values = series.flat().flatMap((bucket) => [bucket.low, bucket.high]);
  if (values.length === 0) return null;
  return { low: Math.min(...values), high: Math.max(...values) };
}
