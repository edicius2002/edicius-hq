import { formatFlightDate } from '@/features/airfare/data/fareRoutes';
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

/* ------------------------------------------------- what a period contains -- */

/**
 * The two ends of a whole calendar period, both inclusive.
 *
 * Wall clock with no zone, written the way `capturedAt` is written, because
 * that is the only clock these stamps have — see `periodBounds`.
 */
export type PeriodBounds = {
  /** `2026-08-17T00:00`. */
  from: string;
  /** `2026-08-23T23:59`. */
  to: string;
};

const START_OF_DAY = 'T00:00';
const END_OF_DAY = 'T23:59';

/** A UTC millisecond count back to the calendar date it names. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * The Monday an ISO week key stands for.
 *
 * The inverse of `isoWeekKey`, and deliberately built on the same fact that
 * function is built on: 4 January is in week 1 by definition, so the Monday of
 * week 1 is the Monday on or before it and every later week is a whole number
 * of seven-day steps from there. Deriving it any other way would give the page
 * two ideas of where a week starts, and the table would then name a stretch
 * the chart had not bucketed by.
 *
 * The arithmetic is `Date.UTC` throughout for the reason `isoWeekKey` gives:
 * a local `Date` moves the day for a reader west of Greenwich, and this app's
 * default origin is Lima.
 */
function isoWeekMonday(key: string): string | null {
  const parts = /^(\d{4})-W(\d{1,2})$/.exec(key);
  if (!parts) return null;
  const fourth = Date.UTC(Number(parts[1]), 0, 4);
  const weekday = (new Date(fourth).getUTCDay() + 6) % 7; // Monday = 0
  return utcDay(fourth - weekday * DAY_MS + (Number(parts[2]) - 1) * 7 * DAY_MS);
}

/**
 * The whole calendar unit a bucket key stands for, end to end.
 *
 * A day is 00:00 to 23:59, a week is Monday 00:00 to Sunday 23:59, a month is
 * the first at 00:00 to the last at 23:59. The alternative — and what this
 * page shipped first — was to report the first and last observation actually
 * found inside the bucket, which reads as a narrower claim than the one being
 * made: a week with one Tuesday collection was announced as "on 18/08/2026"
 * while it was in fact counting everything from the Monday to the Sunday. The
 * stated window and the counted set are now the same set.
 *
 * Being the inverse of `bucketKey`, it is the one place the page turns a key
 * back into dates — the chart's crosshair and the table's caption both come
 * through here, so neither can disagree with the other about what a period is.
 */
export function periodBounds(key: string, granularity: Granularity): PeriodBounds {
  if (granularity === 'month') {
    const [year, month] = key.split('-').map(Number);
    if (!year || !month) return { from: `${key}${START_OF_DAY}`, to: `${key}${END_OF_DAY}` };
    // Day zero of the next month is the last day of this one, leap years
    // included, which is why the length is asked of the calendar rather than
    // looked up in a table of twelve numbers.
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    return {
      from: `${key}-01${START_OF_DAY}`,
      to: `${key}-${String(last).padStart(2, '0')}${END_OF_DAY}`,
    };
  }

  if (granularity === 'week') {
    const monday = isoWeekMonday(key);
    if (monday === null) return { from: `${key}${START_OF_DAY}`, to: `${key}${END_OF_DAY}` };
    const sunday = utcDay(Date.parse(`${monday}T00:00:00Z`) + 6 * DAY_MS);
    return { from: `${monday}${START_OF_DAY}`, to: `${sunday}${END_OF_DAY}` };
  }

  return { from: `${key}${START_OF_DAY}`, to: `${key}${END_OF_DAY}` };
}

/**
 * A period in words, with its clock, so nobody has to infer it.
 *
 * The clock is written out even though it is always 00:00 and 23:59: those two
 * numbers are the whole point of the change: they say the window is the whole
 * calendar unit and not the stretch between the first and last thing seen in
 * it. Dates are split out of the string rather than parsed, for the reason the
 * rest of this feature splits them — `new Date('2026-08-17')` is midnight UTC
 * and prints as the 16th anywhere west of Greenwich.
 */
export function boundsLabel(bounds: PeriodBounds): string {
  const [fromDay, fromClock] = bounds.from.split('T');
  const [toDay, toClock] = bounds.to.split('T');
  if (fromDay === toDay) return `on ${formatFlightDate(fromDay)}, ${fromClock} to ${toClock}`;
  return `between ${formatFlightDate(fromDay)} ${fromClock} and ${formatFlightDate(toDay)} ${toClock}`;
}

function labelFor(key: string, granularity: Granularity): string {
  if (granularity === 'month') return key;
  if (granularity === 'week') return key.replace('-W', ' wk ');
  return key.slice(5); // MM-DD; the year is on the axis, not on every tick
}

/**
 * One period's prices reduced to the five numbers a chart draws.
 *
 * The label is handed in rather than derived, because since 12.170 a bucket
 * key is not always a calendar key: the lead-time axis buckets by whole days
 * before departure and spells its own periods. Everything else about a bucket
 * — that it is a band and a middle, and that the middle is a median — is the
 * same measurement whichever axis it lands on, and belongs in one place.
 */
export function summarise(key: string, label: string, prices: number[]): Bucket {
  return {
    key,
    label,
    low: Math.min(...prices),
    high: Math.max(...prices),
    // Median rather than mean: one collection during a fare glitch should not
    // drag a whole week's middle with it.
    middle: median(prices),
    count: prices.length,
  };
}

/* ------------------------------------------------------ how an axis reads -- */

/**
 * What a chart of these buckets is a chart *of* — 12.170.
 *
 * `PriceBandChart` draws a band, a middle and the provider's line behind them,
 * and none of that geometry cares whether the x axis is calendar time or days
 * before departure. What differs is entirely words and order: what one bucket
 * is called, what a key covers when it is spelled out under the crosshair, and
 * which way the axis runs. Passing those in as a value is what lets the two
 * views share one chart rather than become two components that drift apart —
 * the lead-time view inherits 12.61's crosshair and 12.62's tag placement
 * instead of having to earn them again.
 *
 * `order` is not decoration. The calendar axis runs oldest to newest, which is
 * ascending on its keys; the lead-time axis runs *furthest ahead* to the day
 * of departure, which is descending on its own. A chart that sorted its keys
 * one fixed way could only ever draw one of them the right way round.
 */
export type BucketAxis = {
  /** The noun for one bucket, singular and plural — `week`, `lead week`. */
  unit: { one: string; many: string };
  /** What a key covers, spelled out for the readout and the live region. */
  spell: (key: string) => string;
  /** The order the keys are drawn in, left to right. */
  order: (a: string, b: string) => number;
  /** What the second, dashed series is — the legend line under the chart. */
  baselineLegend: string;
};

/**
 * Calendar time: the axis this chart has always been drawn on.
 *
 * Kept as a value with the same shape as `leadAxis` rather than left implicit,
 * so neither view is the special case — the observation-time view reads
 * exactly as it did, and the difference between the two is one object.
 */
export function calendarAxis(granularity: Granularity): BucketAxis {
  return {
    unit: { one: granularity, many: `${granularity}s` },
    spell: (key) => boundsLabel(periodBounds(key, granularity)),
    order: (a, b) => a.localeCompare(b),
    baselineLegend: 'What the provider says it usually costs — one rounded figure a day',
  };
}

/**
 * A series split into runs of buckets that are neighbours on the axis.
 *
 * Drawn as one path, a series with a hole in it is a straight line across the
 * hole — and a straight line between two observations is a claim that the fare
 * moved evenly through a period nobody looked at. On the lead-time axis that
 * is not a corner case: our own archive reaches 31 of the 91 lead days the
 * provider's does, so most of that axis is a stretch we have never observed
 * and the band has to stop rather than stretch across it.
 *
 * `keys` is the merged axis — every key either series puts on it — so
 * adjacency means "nothing is drawn between these two", not "these two dates
 * are consecutive". A period neither series reached is not on the axis at all
 * and so cannot make a hole.
 */
export function contiguousRuns(keys: string[], series: Bucket[]): Bucket[][] {
  const rank = new Map(keys.map((key, index) => [key, index]));
  const runs: Bucket[][] = [];
  let last: number | null = null;
  for (const bucket of series) {
    const index = rank.get(bucket.key);
    if (index === undefined) continue;
    if (last !== null && index === last + 1) runs[runs.length - 1].push(bucket);
    else runs.push([bucket]);
    last = index;
  }
  return runs;
}

/**
 * Our own observations, gathered into periods.
 *
 * The price taken from each snapshot is its cheapest offer, so `low` and
 * `high` are the range of *the cheapest fare over the period* — not the range
 * of every itinerary on the board. Those are different questions, and this one
 * is the one the series has always answered.
 *
 * Since 12.110 a period holds every departure in the watched month as well as
 * every observation of them, so a day's band is the cheapest and dearest that
 * *any day in March* could be had for on that date. That is a wider band than
 * it used to be and it is the right one: the reader is choosing a departure
 * inside the month, and the spread between its best and worst day is the whole
 * thing they are choosing between.
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
    .map(([key, prices]) => summarise(key, labelFor(key, granularity), prices))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * The provider's own daily history, gathered the same way.
 *
 * Kept in its own function and its own series because it is one rounded
 * integer per day with no airline and no departure time, which is why it is
 * drawn behind ours rather than merged into it.
 *
 * The provider reports a separate series per departure, so a watched month
 * brings back one per day of it and a bucket does get a band — the same band
 * `bucketSnapshots` now produces, and for the same reason. Before 12.110 a
 * single departure gave one value a day and this could only ever be a line.
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
    .map(([key, prices]) => summarise(key, labelFor(key, granularity), prices))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Every price either series puts on the chart, for scaling the axis to both. */
export function spanOf(...series: Bucket[][]): { low: number; high: number } | null {
  const values = series.flat().flatMap((bucket) => [bucket.low, bucket.high]);
  if (values.length === 0) return null;
  return { low: Math.min(...values), high: Math.max(...values) };
}
