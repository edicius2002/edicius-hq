import { formatFlightDate } from '@/features/airfare/data/fareRoutes';
import { bucketKey, type Granularity } from '@/features/airfare/lib/buckets';
import {
  flightKey,
  trackFlights,
  variation,
  type FlightTrack,
} from '@/features/airfare/lib/flights';
import { formatDuration } from '@/features/airfare/lib/series';
import type { FareSnapshot } from '@/shared/api/fares';

/**
 * The flight table's arithmetic: which flights the chart's period covers, how
 * they sort, what a filter keeps, and which of them fit on a page.
 *
 * Pure, and tested without a browser, for the same reason `series.ts` is: the
 * component decides how a row looks, never which rows there are. A sort that
 * puts a flight with no previous price at the top is a bug in a comparator,
 * and a comparator is a thing you can test in a millisecond.
 */

/**
 * Ten rows.
 *
 * A board of thirty-odd itineraries is the normal size of a route here, so a
 * page has to be small enough that paging is worth doing at all; ten leaves
 * the panel roughly the height of the chart above it rather than three times
 * it.
 */
export const PAGE_SIZE = 10;

/* ------------------------------------------------------------- the period -- */

/**
 * The stretch of *observation* time the table covers.
 *
 * Observation time, not flight time: a watched route has exactly one departure
 * date, so bucketing rows by when they fly would put every flight in one
 * bucket and mean nothing. The chart's x-axis is when a snapshot was captured,
 * and this is the same axis, narrowed to its most recent bucket.
 */
export type ObservationWindow = {
  /** The bucket key the chart would draw last — `2026-08-18`, `2026-W34`, `2026-08`. */
  key: string;
  /** First and last calendar date of observation inside that bucket. */
  from: string;
  to: string;
};

/**
 * The most recent day, ISO week or calendar month the collector actually
 * looked in.
 *
 * Keyed through `bucketKey` rather than through its own date arithmetic, so
 * the table's idea of a week cannot drift from the chart's — the ISO week rule
 * lives in `buckets.ts` and is the reason a week here starts on a Monday
 * wherever the reader is. The keys sort as strings in all three granularities,
 * which is why picking the newest is a `>` and not a parse.
 */
export function observationWindow(
  snapshots: FareSnapshot[],
  granularity: Granularity,
): ObservationWindow | null {
  let key: string | null = null;
  for (const snapshot of snapshots) {
    const candidate = bucketKey(snapshot.capturedAt, granularity);
    if (key === null || candidate > key) key = candidate;
  }
  if (key === null) return null;

  const dates = snapshots
    .filter((snapshot) => bucketKey(snapshot.capturedAt, granularity) === key)
    .map((snapshot) => snapshot.capturedAt.slice(0, 10))
    .sort();
  return { key, from: dates[0], to: dates[dates.length - 1] };
}

/**
 * The period, in words, so the reader can check it against what they meant.
 *
 * "The most recent week" is an interpretation of the granularity switch, and
 * an unstated interpretation is one nobody can correct. Dates are written by
 * splitting the string: these stamps are wall clock with no zone, and a `Date`
 * round trip moves the day for a reader west of Greenwich.
 */
export function windowLabel(period: ObservationWindow | null): string {
  if (period === null) return '';
  if (period.from === period.to) return `on ${formatFlightDate(period.from)}`;
  return `between ${formatFlightDate(period.from)} and ${formatFlightDate(period.to)}`;
}

/* --------------------------------------------------------------- the rows -- */

/**
 * What a flight has done, as one word.
 *
 * A numeric range would be the wrong control here: the useful questions are
 * "what moved" and "what disappeared", and neither is a band of percentages.
 * Every row falls in exactly one category.
 */
export type ChangeCategory = 'rose' | 'fell' | 'unchanged' | 'new' | 'gone';

export const CHANGE_ORDER: ChangeCategory[] = ['rose', 'fell', 'unchanged', 'new', 'gone'];

export const CHANGE_LABELS: Record<ChangeCategory, string> = {
  rose: 'Rose',
  fell: 'Fell',
  unchanged: 'Unchanged',
  new: 'New',
  gone: 'Off the board',
};

export type FlightRow = {
  track: FlightTrack;
  /** Percentage move since this flight's last price change, or null if it never moved. */
  change: number | null;
  category: ChangeCategory;
  /** Departure hour at the airport, 0–23, or null when the stamp carries no clock. */
  hour: number | null;
};

export type FlightTableRows = {
  rows: FlightRow[];
  period: ObservationWindow | null;
  /** Every flight the archive has ever seen on this route, in or out of the period. */
  tracked: number;
};

/**
 * The hour a flight leaves, read off the string.
 *
 * Null rather than midnight when there is no clock: `Number('')` is zero, and
 * a zero here would file an unknown departure under "night" and let a band
 * filter claim it knew.
 */
export function departureHour(departureAt: string): number | null {
  const clock = departureAt.split('T')[1];
  if (!clock) return null;
  const hour = Number(clock.slice(0, 2));
  return Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : null;
}

/**
 * Which of the five things happened to this flight.
 *
 * `trackFlights` records a price only when it differs from the one before it,
 * so a null change means "has never moved while watched" — which is a
 * different fact from "we have only just met it", and the two must not share a
 * filter. They are told apart by whether the flight's first observation *is*
 * the newest one on the route.
 *
 * A flight that moved is reported as having moved even if it appeared this
 * week: a measured percentage says more than the word "new", and "new" is
 * exactly the category for the rows that have no percentage to show.
 */
function categoryOf(
  track: FlightTrack,
  change: number | null,
  latestCapture: string,
): ChangeCategory {
  if (!track.present) return 'gone';
  if (change !== null && change > 0) return 'rose';
  if (change !== null && change < 0) return 'fell';
  if (change === null && track.observations[0]?.capturedAt === latestCapture) return 'new';
  return 'unchanged';
}

/**
 * Every flight seen during the chart's most recent period, with its history.
 *
 * The period narrows *which flights are listed*; it deliberately does not
 * narrow the history behind the Change column. Rebuilding the tracks from the
 * period's snapshots alone was the other option and it lies at day
 * granularity: a day usually holds one or two collections, so a fare that had
 * been falling all week would be reported as having never moved. The rows are
 * "what was on the board this period"; the numbers are still the whole
 * archive's answer.
 *
 * Membership is computed from the snapshots rather than from a track's
 * observations, because those are de-duplicated — a flight sat at the same
 * price for a week has its last observation stamped a week ago and was on the
 * board this morning all the same.
 */
export function tableRows(snapshots: FareSnapshot[], granularity: Granularity): FlightTableRows {
  const tracks = trackFlights(snapshots);
  const period = observationWindow(snapshots, granularity);
  if (period === null) return { rows: [], period: null, tracked: tracks.length };

  const seen = new Set<string>();
  let latestCapture = '';
  for (const snapshot of snapshots) {
    if (snapshot.capturedAt > latestCapture) latestCapture = snapshot.capturedAt;
    if (bucketKey(snapshot.capturedAt, granularity) !== period.key) continue;
    for (const offer of snapshot.offers) seen.add(flightKey(offer));
  }

  const rows = tracks
    .filter((track) => seen.has(track.key))
    .map((track) => {
      const change = variation(track.previousPrice, track.price);
      return {
        track,
        change,
        category: categoryOf(track, change, latestCapture),
        hour: departureHour(track.departureAt),
      };
    });

  return { rows, period, tracked: tracks.length };
}

/* ------------------------------------------------------------ the filters -- */

export type TimeBand = 'night' | 'morning' | 'afternoon' | 'evening';

/**
 * Four bands rather than a from/to hour pair.
 *
 * Two more controls to say "an afternoon flight" is two controls too many, and
 * the hours a board actually offers are lumpy — a route with six departures
 * has six hours, and a select of six exact hours reads as a list of the
 * flights rather than as a filter. Only the bands that hold a flight are ever
 * offered.
 */
export const TIME_BANDS: { value: TimeBand; label: string; from: number; to: number }[] = [
  { value: 'night', label: 'Night 00–05', from: 0, to: 5 },
  { value: 'morning', label: 'Morning 06–11', from: 6, to: 11 },
  { value: 'afternoon', label: 'Afternoon 12–17', from: 12, to: 17 },
  { value: 'evening', label: 'Evening 18–23', from: 18, to: 23 },
];

export type Filters = {
  minPrice: number | null;
  maxPrice: number | null;
  /** The carrier's IATA code, which is stable where its printed name is not. */
  airline: string | null;
  band: TimeBand | null;
  stops: number | null;
  /** In minutes, inclusive. */
  maxDuration: number | null;
  change: ChangeCategory | null;
};

export const NO_FILTERS: Filters = {
  minPrice: null,
  maxPrice: null,
  airline: null,
  band: null,
  stops: null,
  maxDuration: null,
  change: null,
};

export function isFiltered(filters: Filters): boolean {
  return (Object.keys(NO_FILTERS) as (keyof Filters)[]).some(
    (field) => filters[field] !== NO_FILTERS[field],
  );
}

/** `0` reads as a number where "Direct" reads as a fact about the flight. */
export function stopsLabel(transfers: number): string {
  if (transfers <= 0) return 'Direct';
  return `${transfers} stop${transfers === 1 ? '' : 's'}`;
}

/** A negative transfer count is not a thing; it is folded into "direct". */
function stopsOf(row: FlightRow): number {
  return Math.max(0, row.track.transfers);
}

function inBand(hour: number | null, band: TimeBand): boolean {
  if (hour === null) return false;
  const span = TIME_BANDS.find((candidate) => candidate.value === band);
  return span !== undefined && hour >= span.from && hour <= span.to;
}

/**
 * What survives the filter bar.
 *
 * A row that cannot answer a question fails it rather than passing: a flight
 * with no duration is not "under four hours", and a departure with no clock is
 * not an evening flight. Both are dropped, and the caption above the table
 * says how many rows the filters took — decisions 8.8 and 8.41, applied to a
 * table instead of to a quote.
 */
export function filterRows(rows: FlightRow[], filters: Filters): FlightRow[] {
  return rows.filter((row) => {
    if (filters.minPrice !== null && row.track.price < filters.minPrice) return false;
    if (filters.maxPrice !== null && row.track.price > filters.maxPrice) return false;
    if (filters.airline !== null && row.track.airline !== filters.airline) return false;
    if (filters.band !== null && !inBand(row.hour, filters.band)) return false;
    if (filters.stops !== null && stopsOf(row) !== filters.stops) return false;
    if (filters.maxDuration !== null) {
      const minutes = row.track.durationMinutes;
      if (minutes === null || minutes > filters.maxDuration) return false;
    }
    if (filters.change !== null && row.category !== filters.change) return false;
    return true;
  });
}

/* ------------------------------------------------------------- the facets -- */

export type Facets = {
  airlines: { value: string; label: string }[];
  price: { low: number; high: number } | null;
  bands: TimeBand[];
  stops: number[];
  /** Distinct durations present, shortest first, as minutes. */
  durations: number[];
  categories: ChangeCategory[];
};

/**
 * The options the filter bar may offer, read off the rows it will filter.
 *
 * Hard-coded options are a way of asking for an empty table: a route flown by
 * two carriers would offer twenty, and a domestic hop with nothing over two
 * hours would offer "under twelve hours". Every option here is a value some
 * visible row actually has, so no single choice can ever empty the table on
 * its own.
 */
export function facetsOf(rows: FlightRow[]): Facets {
  const airlines = new Map<string, string>();
  const stops = new Set<number>();
  const durations = new Set<number>();
  const categories = new Set<ChangeCategory>();
  const hours: number[] = [];
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;

  for (const row of rows) {
    airlines.set(row.track.airline, row.track.airlineName ?? row.track.airline);
    stops.add(stopsOf(row));
    if (row.track.durationMinutes !== null) durations.add(row.track.durationMinutes);
    categories.add(row.category);
    if (row.hour !== null) hours.push(row.hour);
    low = Math.min(low, row.track.price);
    high = Math.max(high, row.track.price);
  }

  return {
    airlines: [...airlines.entries()]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    price: rows.length === 0 ? null : { low, high },
    bands: TIME_BANDS.filter((band) =>
      hours.some((hour) => hour >= band.from && hour <= band.to),
    ).map((band) => band.value),
    stops: [...stops].sort((a, b) => a - b),
    durations: [...durations].sort((a, b) => a - b),
    categories: CHANGE_ORDER.filter((category) => categories.has(category)),
  };
}

/** `Up to 3h 35m`, for the duration select's options. */
export function durationLabel(minutes: number): string {
  return `Up to ${formatDuration(minutes)}`;
}

/* ------------------------------------------------------------ the sorting -- */

export type SortColumn =
  'departs' | 'airline' | 'flight' | 'stops' | 'duration' | 'price' | 'change';

export type SortDirection = 'asc' | 'desc';

export type Sort = { column: SortColumn; direction: SortDirection };

/**
 * Departure time, earliest first.
 *
 * `trackFlights` returns the board with the flights that have left it pushed
 * to the end, which is a sensible order and not a sort anyone asked for. Once
 * every column sorts, one of them has to be the one in effect, and a departure
 * board is read by time; the flights that are gone are marked in their own
 * column and can be filtered out in one click.
 */
export const DEFAULT_SORT: Sort = { column: 'departs', direction: 'asc' };

/** Clicking a new column starts it ascending; clicking the current one turns it. */
export function nextSort(current: Sort, column: SortColumn): Sort {
  if (current.column !== column) return { column, direction: 'asc' };
  return { column, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

function sortKey(row: FlightRow, column: SortColumn): string | number | null {
  switch (column) {
    case 'departs':
      // The stamp sorts as text because it is fixed-width ISO, and because
      // parsing it would shift a 00:15 Lima departure into the reader's zone.
      return row.track.departureAt;
    case 'airline':
      return (row.track.airlineName ?? row.track.airline).toLowerCase();
    case 'flight':
      return `${row.track.airline} ${row.track.flightNumber ?? ''}`.toLowerCase();
    case 'stops':
      return stopsOf(row);
    case 'duration':
      return row.track.durationMinutes;
    case 'price':
      return row.track.price;
    case 'change':
      return row.change;
  }
}

/** Departure, then the flight's identity: two rows never swap between renders. */
function tiebreak(a: FlightRow, b: FlightRow): number {
  const departure = a.track.departureAt.localeCompare(b.track.departureAt);
  return departure !== 0 ? departure : a.track.key.localeCompare(b.track.key);
}

/**
 * The rows in the order the header asks for, with the blanks at the bottom.
 *
 * Nulls sort last in *both* directions on purpose. A flight with no duration,
 * or with no earlier price to compare against, has nothing to say about the
 * column being sorted, and letting the descending pass float those rows to the
 * top would hand the reader a screen of em dashes and call it "the biggest
 * movers".
 */
export function sortRows(rows: FlightRow[], sort: Sort): FlightRow[] {
  const direction = sort.direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = sortKey(a, sort.column);
    const right = sortKey(b, sort.column);
    if (left === null || right === null) {
      if (left === right) return tiebreak(a, b);
      return left === null ? 1 : -1;
    }
    const order =
      typeof left === 'string' ? left.localeCompare(String(right)) : left - Number(right);
    return order !== 0 ? order * direction : tiebreak(a, b);
  });
}

/* --------------------------------------------------------- the pagination -- */

export type PageSlice = {
  page: number;
  pageCount: number;
  rows: FlightRow[];
};

/**
 * One page of rows, with the page number clamped into the range that exists.
 *
 * Clamped rather than trusted: a filter applied while the reader is on page
 * four leaves a page number with nothing behind it, and an empty table with
 * working "previous" buttons is a worse answer than the last page of what is
 * left.
 */
export function pageOf(rows: FlightRow[], page: number, size = PAGE_SIZE): PageSlice {
  const pageCount = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const start = (current - 1) * size;
  return { page: current, pageCount, rows: rows.slice(start, start + size) };
}

/* --------------------------------------------------------- what is hidden -- */

export type SummaryFacts = {
  period: ObservationWindow | null;
  /** Flights seen in the period, before any filter. */
  inPeriod: number;
  /** Flights left after the filters. */
  shown: number;
  /** Flights the archive has ever seen on this route. */
  tracked: number;
  page: number;
  pageCount: number;
};

/**
 * The caption, which has to say what the table is not showing.
 *
 * A table that reports "3 itineraries" reads as the whole board — decisions
 * 8.8 and 8.41 again: what was dropped travels beside what was kept, and says
 * why it was dropped. Three facts, in the order a reader needs them: which
 * stretch of watching this is, how much of it the filters took, and where in
 * the pages they are.
 */
export function tableSummary(facts: SummaryFacts): string {
  const { period, inPeriod, shown, tracked, page, pageCount } = facts;
  const flights = `${inPeriod} flight${inPeriod === 1 ? '' : 's'}`;
  const window = period === null ? '' : ` seen ${windowLabel(period)}`;
  const archive = tracked > inPeriod ? `, of ${tracked} ever observed on this route` : '';

  const sentences = [`${flights}${window}${archive}.`];
  if (shown < inPeriod) {
    sentences.push(`${shown} shown, ${inPeriod - shown} hidden by filters.`);
  }
  sentences.push(`Page ${page} of ${pageCount}.`);
  return sentences.join(' ');
}
