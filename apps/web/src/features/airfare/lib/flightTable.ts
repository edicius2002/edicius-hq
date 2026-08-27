import {
  boundsLabel,
  bucketKey,
  periodBounds,
  type Granularity,
} from '@/features/airfare/lib/buckets';
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
 * Observation time, not flight time. Bucketing rows by when they fly would
 * answer a different question from the chart above them, which is drawn on
 * when a snapshot was captured; this is the same axis, narrowed to its most
 * recent bucket. Since 12.110 a watched route spans a month of departures, so
 * flight time is now a real axis and it is the *other* one — the day column
 * carries it, and the two must not be swapped without saying so.
 */
export type ObservationWindow = {
  /** The bucket key the chart would draw last — `2026-08-18`, `2026-W34`, `2026-08`. */
  key: string;
  /** The whole calendar unit that key stands for, both ends inclusive. */
  from: string;
  to: string;
};

/**
 * The most recent day, ISO week or calendar month the collector looked in,
 * reported as the whole calendar unit rather than as the stretch it happened
 * to find something in.
 *
 * The bounds used to be the first and last observation inside the bucket, and
 * that quietly understated the claim: a week whose only collection landed on
 * the Tuesday was announced as "on 18/08/2026" while the rows underneath were
 * everything the whole Monday-to-Sunday week had seen. Now the sentence and
 * the set are the same set — `periodBounds` gives 00:00 on the first day to
 * 23:59 on the last, and nothing outside those two stamps is counted.
 *
 * Keyed through `bucketKey` and bounded through `periodBounds` rather than
 * through date arithmetic of its own, so the table's idea of a week cannot
 * drift from the chart's — both rules live in `buckets.ts`, which is why a
 * week here starts on a Monday wherever the reader is. The keys sort as
 * strings in all three granularities, which is why picking the newest is a `>`
 * and not a parse.
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
  return { key, ...periodBounds(key, granularity) };
}

/**
 * The period, in words, so the reader can check it against what they meant.
 *
 * "The most recent week" is an interpretation of the granularity switch, and
 * an unstated interpretation is one nobody can correct. The wording itself is
 * `buckets.boundsLabel`'s, shared with the chart's crosshair so the two panels
 * cannot describe the same period in two different ways.
 */
export function windowLabel(period: ObservationWindow | null): string {
  return period === null ? '' : boundsLabel(period);
}

/* --------------------------------------------------------------- the rows -- */

/**
 * What a flight has done, as one word.
 *
 * A numeric range would be the wrong control here: the useful questions are
 * "what moved" and "what disappeared", and neither is a band of percentages.
 * Every row falls in exactly one category.
 *
 * `first` is "we have looked at this flight once, so there is nothing to
 * compare its price against" — 12.254. It was called `new` and it read as a
 * claim about the board rather than about the archive; a route collected for
 * the first time this morning has not just gained 103 flights, it has been
 * watched once.
 */
export type ChangeCategory = 'rose' | 'fell' | 'unchanged' | 'first' | 'gone';

export const CHANGE_ORDER: ChangeCategory[] = ['rose', 'fell', 'unchanged', 'first', 'gone'];

/**
 * One word per category, used both in the Change cell and in the filter that
 * selects on it — the same string in both places, so a reader who picks a
 * category out of the select can see which rows it kept.
 *
 * `gone` is four letters rather than "Off the board" because it shares a
 * column with `+12.3%`: thirteen monospace characters set the width of a
 * column whose widest number is seven, and a table 52px wider is 52px closer
 * to the sideways scrollbar this page is not allowed to have — 12.256.
 */
export const CHANGE_LABELS: Record<ChangeCategory, string> = {
  rose: 'Rose',
  fell: 'Fell',
  unchanged: 'Unchanged',
  first: 'First seen',
  gone: 'Gone',
};

export type FlightRow = {
  track: FlightTrack;
  /**
   * Percentage move since this flight's last price change; `0` when it has been
   * looked at more than once and held its price; null when nothing has been
   * compared — one sighting, or a flight that has left the board.
   */
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
 * Which of the five things happened to this flight, and the number to print.
 *
 * The question the column answers is *how much basis is there for a
 * comparison, and what did the comparison show* — which is why the count of
 * sightings decides it. `trackFlights` records a price only when it differs
 * from the one before, so a track with one observation is either a flight
 * nobody has looked at twice or a flight looked at ten times that never
 * budged, and those are opposite facts sharing one shape.
 *
 * This used to be decided by asking whether the flight's first observation
 * carried the newest `capturedAt` on the whole route, and that was wrong for a
 * reason 12.110 built in: a watched month is polled one departure at a time,
 * 31 requests over about three minutes, so exactly one departure date owns the
 * newest stamp and every flight on the other thirty is judged against a clock
 * reading from a different request. Measured on the archive of 2026-08-19:
 * ARI-SCL holds 103 itineraries, every one of them seen exactly once, and 101
 * of them were filed as "Unchanged" — a price that had never been compared to
 * anything, reported as a price that did not move.
 *
 * Counting sightings rather than fixing the stamp to be per-departure: the two
 * are equivalent — a present flight seen once is by definition in the newest
 * snapshot of its own departure — but one of them states the fact and the
 * other tests a string for equality and hopes the collector stamped it the way
 * we expect.
 *
 * A flight that moved is reported as having moved even if this is the first
 * period it appears in: a measured percentage says more than "first seen", and
 * "first seen" is exactly the category for the rows that have no percentage to
 * show.
 */
function moveOf(
  track: FlightTrack,
  sightings: number,
): { change: number | null; category: ChangeCategory } {
  // A flight that has left the board has no current price, so it has no move
  // to report; the last thing it did before leaving is not what it has done
  // since we last looked, which is what the column asks.
  if (!track.present) return { change: null, category: 'gone' };

  const moved = variation(track.previousPrice, track.price);
  if (moved !== null && moved !== 0) {
    return { change: moved, category: moved > 0 ? 'rose' : 'fell' };
  }

  // Zero rather than a dash: two looks at the same price is a measurement, and
  // the reader can tell it apart from the row below that has never been
  // measured at all.
  if (sightings > 1) return { change: 0, category: 'unchanged' };
  return { change: null, category: 'first' };
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
  /*
   * How many boards each flight has been on, counted per snapshot rather than
   * per offer: a board that lists the same itinerary twice has still only been
   * looked at once, and counting offers would let a duplicate row claim a
   * comparison nobody made.
   */
  const sightings = new Map<string, number>();
  for (const snapshot of snapshots) {
    const inPeriod = bucketKey(snapshot.capturedAt, granularity) === period.key;
    for (const key of new Set(snapshot.offers.map(flightKey))) {
      sightings.set(key, (sightings.get(key) ?? 0) + 1);
      if (inPeriod) seen.add(key);
    }
  }

  const rows = tracks
    .filter((track) => seen.has(track.key))
    .map((track) => ({
      track,
      ...moveOf(track, sightings.get(track.key) ?? 0),
      hour: departureHour(track.departureAt),
    }));

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
 *
 * Labelled by the hours alone since 12.255, where it used to read `Afternoon
 * 12–17`. Fifteen monospace characters made this the widest control on the
 * filter row and the reason the row could not hold every filter at once; five
 * characters fit, and they are the half that cannot be misread — a reader who
 * picks "Morning" has to guess whether 11:30 is in it, and one who picks
 * `06–11` does not. The field above them already says `Departs`, so the word
 * was carrying no meaning the control had not already stated.
 */
export const TIME_BANDS: { value: TimeBand; label: string; from: number; to: number }[] = [
  { value: 'night', label: '00–05', from: 0, to: 5 },
  { value: 'morning', label: '06–11', from: 6, to: 11 },
  { value: 'afternoon', label: '12–17', from: 12, to: 17 },
  { value: 'evening', label: '18–23', from: 18, to: 23 },
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

/**
 * How many characters of a carrier's name the filter row can afford.
 *
 * A `<select>` is as wide as its widest option, so one long name sets the
 * width of the whole control whether or not anybody ever picks it — and this
 * one was setting 251px of a row with 1099 to spend. `Aerolineas Argentinas`
 * is 21 characters and carries **19 of the 1275 offers in the archive**, so
 * the bar was being laid out around the carrier least likely to be looked for.
 *
 * Eight, because that is `JetSMART` exactly: the longest carrier name in this
 * archive that the row can afford whole. It leaves LATAM, Avianca and JetSMART
 * — 1256 of those 1275 offers — untouched, and cuts precisely one name.
 */
export const AIRLINE_LABEL_MAX = 8;

/**
 * A carrier's name, cut to the room the filter row has for it.
 *
 * A real ellipsis rather than a silent clip. `max-width` on the `<select>` was
 * tried first and rejected on measurement: Chrome ignores `text-overflow` on
 * the closed control and simply cuts the glyphs off, so the name read
 * `Aerolineas Argenti` with nothing to say it had been shortened — which is a
 * name a reader has no reason to doubt. The `…` is that reason.
 *
 * A prefix can collide where two carriers share an opening: `American
 * Airlines` and `American Eagle` would both read `America…`. That is why the
 * full name travels on the option's `title` and the Airline cell's title. The
 * table now uses the same short spelling: the board is an index of flights,
 * while the full carrier remains available without setting the column width.
 */
export function shortAirline(label: string, max = AIRLINE_LABEL_MAX): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1).trimEnd()}…`;
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
};

/**
 * The caption, which has to say what the table is not showing.
 *
 * A table that reports "3 itineraries" reads as the whole board — decisions
 * 8.8 and 8.41 again: what was dropped travels beside what was kept, and says
 * why it was dropped. Two facts, in the order a reader needs them: which
 * stretch of watching this is, and how much of it the filters took.
 *
 * Where in the pages the reader is used to be a third sentence here, and it is
 * gone with 12.253 — the pager under the table has said `Page 1 of 2` beside
 * its own buttons all along, and one page number is enough. It is the pager's
 * because that is where a reader who wants a different page is looking.
 */
export function tableSummary(facts: SummaryFacts): string {
  const { period, inPeriod, shown, tracked } = facts;
  const flights = `${inPeriod} flight${inPeriod === 1 ? '' : 's'}`;
  const window = period === null ? '' : ` seen ${windowLabel(period)}`;
  const archive = tracked > inPeriod ? `, of ${tracked} ever observed on this route` : '';

  const sentences = [`${flights}${window}${archive}.`];
  if (shown < inPeriod) {
    sentences.push(`${shown} shown, ${inPeriod - shown} hidden by filters.`);
  }
  return sentences.join(' ');
}
