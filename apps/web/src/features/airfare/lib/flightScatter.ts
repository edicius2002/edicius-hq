import {
  bucketKey,
  contiguousRuns,
  periodBounds,
  type Granularity,
} from '@/features/airfare/lib/buckets';
import { flightKey } from '@/features/airfare/lib/flights';
import { stopsLabel } from '@/features/airfare/lib/flightTable';
import { formatDuration, formatStamp, latestPerDeparture } from '@/features/airfare/lib/series';
import type { Viewport } from '@/features/airfare/lib/viewport';
import type { FareSnapshot } from '@/shared/api/fares';
import { formatMoney } from '@/shared/lib/money';

/**
 * The arithmetic behind the flight scatter: one point per itinerary, placed by
 * when it *departs* rather than by when we looked at it.
 *
 * This is the other axis of the same archive. `buckets.ts` gathers observations
 * — what the cheapest fare was on each day we asked — and that series answers
 * "is this route cheaper than it was". Since 12.110 a watched route is a whole
 * departure month and the collector brings back the board for every day in it,
 * so a second question became answerable for the first time: *which departure*
 * is the cheap one, and what does the rest of that day's board cost around it.
 * Neither question is the other, which is why this is a second view and not a
 * replacement — 12.140.
 *
 * Everything about calendars comes through `buckets.ts`. A week is defined in
 * exactly one place in this feature and it is `periodBounds`; a second
 * definition here would let the chart and the table disagree about which
 * Monday, which is the failure 12.60 was written to prevent.
 *
 * Pure, and tested without a browser, for the reason `flightTable.ts` and
 * `series.ts` are: the component decides how a dot looks, never where it goes.
 */

const MINUTES_PER_DAY = 1440;
const DAY_MS = 86_400_000;

/* ------------------------------------------------------------ wall clocks -- */

/**
 * Minutes past midnight, read off the string.
 *
 * `departureAt` is wall clock at the airport with no offset — the same rule
 * `series.departureClock` states — so it must never go through `Date`, which
 * would read it in the browser's zone and slide a 00:15 Lima departure onto the
 * previous day for a reader east of it. That is not a rounding error on a chart
 * whose x axis *is* the departure time.
 *
 * Null rather than zero when there is no clock: `Number('')` is 0, and a zero
 * here would draw an unknown departure hard against midnight and let the
 * cheapest-of-day line pick it.
 */
export function clockMinutes(stamp: string): number | null {
  const clock = stamp.split('T')[1];
  if (!clock) return null;
  const [hours, minutes] = clock.slice(0, 5).split(':').map(Number);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** `2027-03-09` → the UTC millisecond count of its midnight, or null. */
function dayMs(day: string): number | null {
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!parts) return null;
  const ms = Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3]));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Whole days from one calendar date to another.
 *
 * `Date.UTC` throughout and never a local `Date`, for the reason `buckets.ts`
 * gives: `new Date('2027-03-01')` is midnight UTC and is the 28th of February
 * in Lima, which is this app's default origin. UTC midnight to UTC midnight is
 * an exact multiple of a day with no daylight saving in it, so the division is
 * safe where a local one would be off by an hour twice a year.
 */
export function dayOffset(from: string, to: string): number | null {
  const start = dayMs(from);
  const end = dayMs(to);
  if (start === null || end === null) return null;
  return Math.round((end - start) / DAY_MS);
}

/** The calendar date `steps` days after `day`, as `YYYY-MM-DD`. */
export function dayPlus(day: string, steps: number): string | null {
  const start = dayMs(day);
  if (start === null) return null;
  return new Date(start + steps * DAY_MS).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------- the window -- */

/**
 * The stretch of *departure* time on the x axis.
 *
 * `from` and `to` are `periodBounds`' own, so this window is the same calendar
 * unit the flight table captions and the price chart's crosshair name — day
 * 00:00 to 23:59, Monday 00:00 to Sunday 23:59, the first of the month to the
 * last. `spanMinutes` is the whole days rather than the distance between the
 * two stamps: a day is 1440 minutes wide even though its last minute is 23:59,
 * and drawing it 1439 wide would put a 23:59 departure exactly on the frame.
 */
export type ScatterWindow = {
  key: string;
  granularity: Granularity;
  /** `2027-03-01T00:00`. */
  from: string;
  /** `2027-03-31T23:59`. */
  to: string;
  /** Whole days the window covers — 1, 7, or 28 to 31. */
  days: number;
  spanMinutes: number;
};

/**
 * The stretch of departure dates the route is a watch on: its own month.
 *
 * It was "or the one day inside it the reader focused" until 12.260, and this
 * stays a pair of dates rather than a month string because the frame it feeds
 * compares dates and because a range is the weaker assumption of the two.
 *
 * Both ends are `YYYY-MM-DD`, and both are inclusive.
 */
export type WatchedRange = { from: string; to: string };

/**
 * The window a period covers — the whole calendar period, both ends included.
 *
 * **It used to be clipped to the watched month and is not any more.** March
 * 2027's last ISO week runs 29 March to 4 April, and while the only thing this
 * chart could draw was boards, those four April dates were four departure dates
 * the frame asserted and nothing could ever be placed on: the clip was right,
 * and it was the same refusal as a line drawn across a hole. What changed is
 * that those dates now have an answer. The calendar curve prices every
 * departure date out to the horizon, so the days past the end of the month are
 * drawn from it rather than left as an empty claim — and clipping them away
 * would now be the chart hiding data it holds.
 *
 * Which dates the boards may speak for is still a question with a hard answer,
 * and it has moved to where it belongs: `departureFrame.frameDays` decides it
 * per date, so a day inside the month whose board came back empty is still a
 * board day and is still marked as one, rather than being handed to a curve
 * that has its own separate answer for it.
 */
export function scatterWindow(key: string, granularity: Granularity): ScatterWindow {
  const bounds = periodBounds(key, granularity);
  const from = bounds.from;
  const to = bounds.to;

  const days = (dayOffset(from.slice(0, 10), to.slice(0, 10)) ?? 0) + 1;
  return {
    key,
    granularity,
    from,
    to,
    days: Math.max(1, days),
    spanMinutes: Math.max(1, days) * MINUTES_PER_DAY,
  };
}

/**
 * How far into the window a departure falls, in minutes, or null if it is
 * outside.
 *
 * **The boundary is the whole point of this function.** A flight departing at
 * 23:59 on the Sunday is in that week and one departing at 00:00 on the Monday
 * is not, and the comparison that decides it is a string comparison on a
 * fixed-width `YYYY-MM-DDTHH:MM` — the same trick the rest of the feature uses
 * to sort stamps without parsing them. Parsing would reintroduce exactly the
 * zone shift that moves a midnight departure into the neighbouring period.
 *
 * Sliced to sixteen characters first, because the archive's stamps are minute
 * precision and a provider that started sending seconds would otherwise put
 * `23:59:30` past a `23:59` boundary and drop the last flight of every week.
 */
export function minutesInto(window: ScatterWindow, departureAt: string): number | null {
  const stamp = departureAt.slice(0, 16);
  if (stamp.length < 16) return null;
  if (stamp < window.from || stamp > window.to) return null;

  const offset = dayOffset(window.from.slice(0, 10), stamp.slice(0, 10));
  const minutes = clockMinutes(stamp);
  if (offset === null || minutes === null) return null;
  return offset * MINUTES_PER_DAY + minutes;
}

/* ------------------------------------------------------------- the points -- */

export type ScatterPoint = {
  /** `flightKey`'s identity, so a dot and a table row are the same flight. */
  key: string;
  departureAt: string;
  /** `YYYY-MM-DD` — the calendar day the dot belongs to. */
  day: string;
  /** `19:55`, wall clock at the airport. */
  clock: string;
  /** Minutes from the start of the window; what the x axis is drawn on. */
  offset: number;
  price: number;
  currency: string;
  airline: string;
  airlineName: string | null;
  flightNumber: string | null;
  transfers: number;
  durationMinutes: number | null;
  /** Whether this is the cheapest flight of its own departure day. */
  cheapestOfDay: boolean;
};

/**
 * The board of each departure day as that day was last seen, one point per
 * itinerary.
 *
 * Built from `latestPerDeparture` and not from the whole archive, which is
 * 12.115 applied to a chart: a month is polled one departure at a time, so
 * every snapshot ever written for the month would put the same flight on the
 * canvas once per collection and draw a vertical smear where there is one
 * flight. The board as last seen is also what the detail panel above already
 * describes and what the cheapest-departure figure is computed from, so the dot
 * the reader picks out as the low point of the month is by construction the
 * same flight that panel names.
 *
 * A flight whose stamp carries no clock is dropped rather than placed at
 * midnight — there is no honest x for it, and the flight table below still
 * lists it.
 *
 * One dot per `flightKey`, keeping the cheaper where a board offers the same
 * identity twice. `flights.flightKey` is this feature's answer to "is this the
 * same flight", and the table and the tracks both take it at its word; two dots
 * for one key would be two claims about one itinerary, and — since the key is
 * also the React key — a duplicate in the DOM.
 */
export function flightPoints(snapshots: FareSnapshot[], window: ScatterWindow): ScatterPoint[] {
  const byFlight = new Map<string, ScatterPoint>();

  for (const snapshot of latestPerDeparture(snapshots)) {
    for (const offer of snapshot.offers) {
      const offset = minutesInto(window, offer.departureAt);
      if (offset === null) continue;
      const key = flightKey(offer);
      const held = byFlight.get(key);
      if (held && held.price <= offer.price) continue;
      byFlight.set(key, {
        key,
        departureAt: offer.departureAt,
        day: offer.departureAt.slice(0, 10),
        clock: offer.departureAt.slice(11, 16),
        offset,
        price: offer.price,
        currency: offer.currency || snapshot.currency,
        airline: offer.airline,
        airlineName: offer.airlineName,
        flightNumber: offer.flightNumber,
        transfers: offer.transfers,
        durationMinutes: offer.durationMinutes,
        cheapestOfDay: false,
      });
    }
  }

  const points = [...byFlight.values()];

  points.sort((a, b) => a.offset - b.offset || a.price - b.price || a.key.localeCompare(b.key));
  return markCheapestOfDay(points);
}

/**
 * Exactly one flight a day carries the flag, and ties go to the earlier
 * departure.
 *
 * A tie is not rare on this data — two carriers matching each other to the dollar
 * is an ordinary morning — and letting both wear the flag would put two nodes
 * on one day of a line that is meant to have one, so the dashes would double
 * back. The earlier departure wins because the points are already in departure
 * order when this runs.
 */
function markCheapestOfDay(points: ScatterPoint[]): ScatterPoint[] {
  const best = new Map<string, ScatterPoint>();
  for (const point of points) {
    const held = best.get(point.day);
    if (!held || point.price < held.price) best.set(point.day, point);
  }
  for (const point of best.values()) point.cheapestOfDay = true;
  return points;
}

/**
 * The cheapest flight of each day, in departure order — the dashed line.
 *
 * This is the shape the reader asked for and the cloud of dots is context
 * behind it. Its nodes are real itineraries, so the line bends up and down the
 * clock as well as across the calendar: the cheapest flight on the 9th may be a
 * red-eye and the cheapest on the 10th a lunchtime one, and a line drawn
 * through the day's *price* at a fixed hour would have hidden that.
 */
export function cheapestPerDay(points: ScatterPoint[]): ScatterPoint[] {
  return points.filter((point) => point.cheapestOfDay).sort((a, b) => a.offset - b.offset);
}

/* ----------------------------------------------------- which period to draw -- */

/**
 * Every departure day the archive can actually place on this canvas.
 *
 * Read off the offers' own `departureAt` rather than off `flightDate`, because
 * `departureAt` is what the dot is placed by: a day whose only snapshot came
 * back with an empty board is not a day with flights on it, and offering it as
 * a period would hand the reader an empty chart with working arrows.
 */
export function departureDays(snapshots: FareSnapshot[]): string[] {
  const days = new Set<string>();
  for (const snapshot of latestPerDeparture(snapshots)) {
    for (const offer of snapshot.offers) {
      const day = offer.departureAt.slice(0, 10);
      if (dayMs(day) === null || clockMinutes(offer.departureAt) === null) continue;
      days.add(day);
    }
  }
  return [...days].sort();
}

/**
 * The periods with something in them, oldest first.
 *
 * Through `bucketKey` rather than through any arithmetic of its own — the same
 * function the price chart buckets observations with, so "week 10" means the
 * same seven days on both views and in the table underneath them.
 */
export function periodKeys(days: string[], granularity: Granularity): string[] {
  const keys = new Set(days.map((day) => bucketKey(day, granularity)));
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * The period to draw, given the day the reader is anchored on.
 *
 * An anchor *day* rather than an index into the periods, because the
 * granularity switch changes what the periods are: an index kept across a week
 * → day flip points at the seventh day of the month instead of at the day the
 * reader was looking at, which is the stale-index failure the price chart's
 * crosshair already guards against. A day survives the flip — the week
 * containing it and the day itself are both derivable from it.
 *
 * An anchor whose period holds nothing falls back to the earliest period that
 * does, which is what happens when the reader switches to a route the anchor
 * has no meaning for.
 */
export function activeKey(
  keys: string[],
  granularity: Granularity,
  anchor: string | null,
): string | null {
  if (keys.length === 0) return null;
  if (anchor !== null) {
    const key = bucketKey(anchor, granularity);
    if (keys.includes(key)) return key;
  }
  return keys[0];
}

/** The neighbouring period that holds flights, or null at either end. */
export function stepKey(keys: string[], current: string, direction: -1 | 1): string | null {
  const index = keys.indexOf(current);
  if (index === -1) return null;
  return keys[index + direction] ?? null;
}

/**
 * The first day with flights inside a period.
 *
 * What a step sets the anchor to, so the anchor is always a real departure day.
 * Setting it to the period's own first *calendar* day would break the next flip
 * of the granularity switch: the Monday of a week can fall outside the watched
 * month, and that Monday is not a day this route has any flights on.
 */
export function firstDayIn(days: string[], key: string, granularity: Granularity): string | null {
  return days.find((day) => bucketKey(day, granularity) === key) ?? null;
}

/* -------------------------------------------------------------- the scales -- */

export type Plot = {
  width: number;
  height: number;
  pad: { top: number; right: number; bottom: number; left: number };
};

export type ScatterSpan = { low: number; high: number };

/**
 * The vertical range, padded and never anchored at zero.
 *
 * The same rule `scales.priceBand` states for the other chart and for the same
 * reason: a board that runs 210 to 380 drawn from zero is a stripe across the
 * top of the box, and the spread between the day's cheapest flight and its
 * dearest is exactly what this view exists to show. Padded by a twelfth rather
 * than a tenth because the dots have a radius and the extremes would otherwise
 * be clipped in half by the frame.
 */
export function priceSpan(points: ScatterPoint[]): ScatterSpan | null {
  return spanOfPrices(points.map((point) => point.price));
}

/**
 * The same range, over bare numbers.
 *
 * A frame that straddles the end of the watched month holds two kinds of price
 * — itineraries on one side of the seam and one figure a date on the other —
 * and both are drawn against one vertical scale, because two scales in one
 * frame would make a fare on the left and a fare on the right different
 * heights. Taking numbers rather than points is what lets the two be scaled
 * together without either side learning the other's shape.
 */
export function spanOfPrices(prices: number[]): ScatterSpan | null {
  if (prices.length === 0) return null;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const margin = Math.max((high - low) / 12, high * 0.02, 1);
  return { low: Math.max(0, low - margin), high: high + margin };
}

/**
 * Where a minute of the frame is drawn.
 *
 * **The viewport is optional and its absence is the whole frame**, which is
 * what every caller meant before there was a zoom. Written as a trailing
 * parameter rather than as a second function because there is exactly one
 * mapping from a minute to an x on this chart, and two of them is how the dots
 * and the axis end up disagreeing about where a date is — the class of bug
 * 12.60 records on the calendar side.
 *
 * A minute outside the viewport still gets an x, off the plot on one side or
 * the other. That is deliberate: the cheapest-flight line has to run to the
 * edge rather than stop at the last visible node, so the clipping is the
 * chart's job and not this function's.
 */
export function xOf(offset: number, window: ScatterWindow, plot: Plot, view?: Viewport): number {
  const usable = plot.width - plot.pad.left - plot.pad.right;
  const start = view?.start ?? 0;
  const span = view?.span ?? window.spanMinutes;
  return plot.pad.left + ((offset - start) / (span || 1)) * usable;
}

/**
 * The inverse of `xOf`: which minute of the window a horizontal position is.
 *
 * Used to decide which *date* the pointer is over, which is the question that
 * has to be answered before the chart knows whether it is looking at a board of
 * itineraries or at one price for a whole day. Unclamped on purpose — a caller
 * that needs an index clamps to the frame it owns, and silently folding a
 * pointer in the left margin onto the first date here would hide that from the
 * one place that can tell.
 */
export function offsetAt(x: number, window: ScatterWindow, plot: Plot, view?: Viewport): number {
  const usable = plot.width - plot.pad.left - plot.pad.right;
  const start = view?.start ?? 0;
  const span = view?.span ?? window.spanMinutes;
  return start + ((x - plot.pad.left) / (usable || 1)) * span;
}

export function yOf(price: number, span: ScatterSpan, plot: Plot): number {
  const usable = plot.height - plot.pad.top - plot.pad.bottom;
  return plot.pad.top + (1 - (price - span.low) / (span.high - span.low || 1)) * usable;
}

export type PlacedPoint = { point: ScatterPoint; x: number; y: number };

export function placePoints(
  points: ScatterPoint[],
  window: ScatterWindow,
  span: ScatterSpan,
  plot: Plot,
  view?: Viewport,
): PlacedPoint[] {
  return points.map((point) => ({
    point,
    x: xOf(point.offset, window, plot, view),
    y: yOf(point.price, span, plot),
  }));
}

/** Every calendar date the window covers, in order — the axis a run is measured against. */
export function windowDays(window: ScatterWindow): string[] {
  const start = window.from.slice(0, 10);
  const days: string[] = [];
  for (let index = 0; index < window.days; index += 1) {
    const day = dayPlus(start, index);
    if (day !== null) days.push(day);
  }
  return days;
}

/**
 * The `d` of the dashed line through the cheapest flight of each day, broken
 * wherever a day has no cheapest flight — 12.230.
 *
 * **This line was the page's one true synthesised continuity.** It emitted a
 * single `M…L…L…` through whatever days happened to carry a dot, so a week
 * collected on the Monday and the following Sunday drew as a straight run from
 * one to the other: five departure days nobody has ever priced, rendered as a
 * fare gliding evenly between two that were. A reader has no way to see that,
 * because a dashed line across a gap looks exactly like a dashed line across a
 * step. The sibling chart had already refused the same claim and the fix is its
 * answer rather than a second one — `contiguousRuns`, widened in 12.230 to
 * split any keyed series, over an axis of every date the window covers.
 *
 * Both reasons a day can be empty break the line and neither is guessed at
 * here: a day the collector never reached and a day whose board came back with
 * nothing on it are both days with no cheapest flight, and drawing through
 * either quotes a fare that was never quoted. Which of the two it was is
 * `absentDays`' business, and it is said on the rail under the plot.
 *
 * A run of one node still draws nothing — a path with one point has no line in
 * it — and neither does the day view, for the reason it never did. The
 * component rings every cheapest-of-day flight, so a stranded day is still
 * marked.
 */
export function cheapestPath(
  points: ScatterPoint[],
  window: ScatterWindow,
  span: ScatterSpan,
  plot: Plot,
  view?: Viewport,
): string {
  const line = cheapestPerDay(points);
  if (line.length < 2) return '';
  // Keyed by the departure day rather than by `flightKey`: what makes two nodes
  // of this line neighbours is that their days are, not that the itineraries
  // are related.
  const nodes = line.map((point) => ({ key: point.day, point }));
  return contiguousRuns(windowDays(window), nodes)
    .filter((run) => run.length > 1)
    .map((run) =>
      run
        .map(
          ({ point }, index) =>
            `${index === 0 ? 'M' : 'L'}${xOf(point.offset, window, plot, view).toFixed(1)},${yOf(point.price, span, plot).toFixed(1)}`,
        )
        .join(''),
    )
    .join('');
}

/**
 * A departure date inside the window with no flight on it, and which kind of
 * nothing it is — 12.232.
 *
 * The distinction is 12.154's, carried onto this chart: a date the collector
 * asked about and got an empty board back for is a fact about the route, and a
 * date it never reached is a fact about us. Both look like blank canvas
 * otherwise, and blank canvas beside a broken line is exactly the question the
 * reader will have.
 *
 * "Answered" is having a snapshot for that departure date at all, which is what
 * the archive can actually say. A board that came back full of itineraries with
 * no departure clock would be counted as answered too — those are dropped from
 * the cloud because there is no honest x for them, and it is still true that we
 * asked.
 */
export type AbsentDay = {
  day: string;
  /** Minutes from the start of the window — midnight of the day, for placing the mark. */
  offset: number;
  /** True where the provider answered and had nothing to sell. */
  answered: boolean;
};

export function absentDays(snapshots: FareSnapshot[], window: ScatterWindow): AbsentDay[] {
  const asked = new Set(snapshots.map((snapshot) => snapshot.flightDate));
  const flown = new Set(flightPoints(snapshots, window).map((point) => point.day));
  const marks: AbsentDay[] = [];
  for (const day of windowDays(window)) {
    if (flown.has(day)) continue;
    const index = dayOffset(window.from.slice(0, 10), day);
    if (index === null) continue;
    marks.push({
      day,
      // The middle of the day rather than its midnight, so the mark sits under
      // the column it is about instead of on the separator between two of them.
      offset: index * MINUTES_PER_DAY + MINUTES_PER_DAY / 2,
      answered: asked.has(day),
    });
  }
  return marks;
}

/**
 * The price a vertical position stands for — the inverse of `yOf`, clamped.
 *
 * Clamped so a pointer up in the top padding reports the top of the band rather
 * than a fare nothing on the chart costs.
 */
export function priceAt(y: number, span: ScatterSpan, plot: Plot): number {
  const usable = plot.height - plot.pad.top - plot.pad.bottom;
  const ratio = 1 - (y - plot.pad.top) / (usable || 1);
  return span.low + Math.min(Math.max(ratio, 0), 1) * (span.high - span.low);
}

/* ---------------------------------------------------------------- the axis -- */

export type AxisTick = { offset: number; label: string };

/**
 * `09/03`, deliberately without the year.
 *
 * The feature writes dates `dd/mm/yyyy` everywhere a reader has to act on one,
 * and this is the one place that convention does not fit: a month view carries
 * seven of these labels across 620 view units, and `09/03/2027` is ten glyphs
 * where `09/03` is five. The year is stated once, in the panel heading and in
 * the window caption under the chart, rather than seven times on an axis.
 *
 * A string split rather than a `Date`, like `formatFlightDate`, which this
 * would otherwise be a call to.
 */
export function axisDayLabel(day: string): string {
  const parts = /^\d{4}-(\d{2})-(\d{2})$/.exec(day);
  return parts ? `${parts[2]}/${parts[1]}` : day;
}

/** `180` → `03:00`. */
export function clockLabel(minutes: number): string {
  const hours = Math.floor(minutes / 60) % 24;
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/**
 * How the x axis reads, which is a different question at each scale.
 *
 * - **Day** — the axis is a clock, ticked every three hours. There is only one
 *   date and it is in the caption, so repeating it eight times would say
 *   nothing; what the reader is comparing is the morning against the evening.
 * - **Week** — one tick per day, at that day's midnight, labelled `dd/mm`. The
 *   clock is still there and still places every dot inside its day, but the
 *   thing being compared has become which *day* is cheap, and seven day marks
 *   are what make a dot's day readable without counting.
 * - **Month** — the same day marks, but labelled every fifth day. Thirty-one
 *   labels of five glyphs do not fit in 620 units and would overlap into a grey
 *   band; every fifth is close enough to count from, and the day separators are
 *   still drawn at every midnight so the dots stay grouped by day.
 *
 * The rule is one sentence: below a week the axis is a clock, at a week and
 * above it is a calendar with the clock inside each day.
 *
 * **A zoom changes the density and never the vocabulary.** Handed a narrowed
 * viewport the axis picks a step from what is *visible* rather than from the
 * frame, because the alternative is the thing a zoom is supposed to fix: six
 * hours of a month view carrying no label at all, since every fifth midnight
 * fell off the plot. What a tick *says* still follows the frame — a day frame
 * is a clock because its date is in the caption, a wider one is a calendar —
 * with one addition that a zoom makes necessary. Zoomed inside a multi-day
 * frame the clock is what the reader needs and the date is what they can lose,
 * so the date is written at each midnight and the clock between them: the
 * calendar appears exactly where the calendar changes.
 *
 * Only visible ticks are returned. The labels sit below the plot floor, outside
 * whatever clips the marks, so one left in for the chart to hide would paint
 * over the price axis.
 */
export function axisTicks(window: ScatterWindow, view?: Viewport): AxisTick[] {
  const full = view === undefined || view.span >= window.spanMinutes - 0.5;
  const start = window.from.slice(0, 10);

  if (full) {
    if (window.days === 1) {
      const ticks: AxisTick[] = [];
      for (let minutes = 0; minutes < MINUTES_PER_DAY; minutes += 180) {
        ticks.push({ offset: minutes, label: clockLabel(minutes) });
      }
      return ticks;
    }

    const every = window.days <= 7 ? 1 : 5;
    const ticks: AxisTick[] = [];
    for (let index = 0; index < window.days; index += every) {
      const day = dayPlus(start, index);
      if (day === null) continue;
      ticks.push({ offset: index * MINUTES_PER_DAY, label: axisDayLabel(day) });
    }
    return ticks;
  }

  const from = view.start;
  const to = view.start + view.span;

  /*
   * Two days is where the axis stops being able to be a calendar. Below it a
   * calendar has at most two marks on screen and the reader is comparing hours;
   * above it the clock ticks would be a picket fence.
   */
  if (view.span <= 2 * MINUTES_PER_DAY) {
    const step = clockStep(view.span);
    const ticks: AxisTick[] = [];
    for (let minutes = Math.ceil(from / step) * step; minutes <= to; minutes += step) {
      const into = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
      if (window.days > 1 && into === 0) {
        const day = dayPlus(start, Math.round(minutes / MINUTES_PER_DAY));
        ticks.push({ offset: minutes, label: day === null ? clockLabel(into) : axisDayLabel(day) });
        continue;
      }
      ticks.push({ offset: minutes, label: clockLabel(into) });
    }
    return ticks;
  }

  const visible = Math.ceil(view.span / MINUTES_PER_DAY);
  const every = Math.max(1, Math.ceil(visible / 7));
  const first = Math.ceil(from / MINUTES_PER_DAY);
  const ticks: AxisTick[] = [];
  for (let index = first; index * MINUTES_PER_DAY <= to && index < window.days; index += every) {
    const day = dayPlus(start, index);
    if (day === null) continue;
    ticks.push({ offset: index * MINUTES_PER_DAY, label: axisDayLabel(day) });
  }
  return ticks;
}

/**
 * The coarsest clock step that still fits about eight labels across the track.
 *
 * A fixed list rather than a computed round number, because the steps a clock
 * can honestly be read at are not arbitrary: a quarter, a half, an hour, then
 * multiples of an hour that divide a day. A step of, say, 47 minutes would tick
 * at 00:47 and 01:34 and be arithmetic rather than a clock.
 *
 * Eight is what the full day view already shows — 1,440 over three hours — so
 * choosing the step this way reproduces that view exactly rather than
 * approaching it.
 */
function clockStep(span: number): number {
  const steps = [15, 30, 60, 120, 180, 360, 720];
  return steps.find((step) => span / step <= 9) ?? 720;
}

/**
 * Every midnight inside a multi-day window, for the faint separators.
 *
 * Drawn at every day even where the labels are every fifth, because grouping
 * the dots by day is what makes the cloud readable — without them a month is
 * one smear 620 units wide. Empty on a day view, where the only midnight is the
 * frame itself.
 */
export function dayBoundaries(window: ScatterWindow): number[] {
  if (window.days <= 1) return [];
  const offsets: number[] = [];
  for (let index = 1; index < window.days; index += 1) offsets.push(index * MINUTES_PER_DAY);
  return offsets;
}

/* ------------------------------------------------------------- the readout -- */

/**
 * The point nearest the pointer, in two dimensions.
 *
 * Two, where the price chart's `nearestBucket` needs only one. That chart has
 * one value per period and snapping horizontally is the whole answer; this one
 * routinely has twenty flights sharing a day and two sharing a minute, so a
 * horizontal snap would pick whichever of a stack the array happened to hold
 * first and the reader could never reach the others. Distance is measured in
 * view units, which is the same unit on both axes.
 *
 * Strictly nearer wins, so a pointer exactly between two dots stays on the
 * first rather than flickering — the same tie rule `nearestBucket` states.
 */
export function nearestPlaced(placed: PlacedPoint[], x: number, y: number): number | null {
  let best: number | null = null;
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < placed.length; index += 1) {
    const dx = placed[index].x - x;
    const dy = placed[index].y - y;
    const distance = dx * dx + dy * dy;
    if (distance < shortest) {
      shortest = distance;
      best = index;
    }
  }
  return best;
}

/** `LA 2075`, or the carrier alone where the provider sent no number. */
export function flightName(point: ScatterPoint): string {
  return point.flightNumber ? `${point.airline} ${point.flightNumber}` : point.airline;
}

/**
 * The tag pinned to the time axis: a clock on a day view, a date and a clock on
 * the wider ones.
 *
 * The date is dropped on a day view because the axis has already said it and
 * the caption says it again — a tag reading `09/03 19:55` under an axis of
 * nothing but hours is three glyphs of noise on the one label that has to stay
 * narrow enough not to leave the plot.
 */
export function pointTimeLabel(point: ScatterPoint, window: ScatterWindow): string {
  return window.days === 1 ? point.clock : `${axisDayLabel(point.day)} ${point.clock}`;
}

/**
 * A flight as a sentence, for the live region.
 *
 * Prose rather than a grid, for the reason `crosshair.readingSentence` gives:
 * an `aria-live` region reads text, and a crosshair only a sighted reader can
 * use would make this panel the exception on a page that is otherwise
 * keyboard-reachable. Money goes through `shared/lib/money` and the stamp
 * through `series.formatStamp`, so a dot and its table row print the same
 * figures in the same shapes.
 */
export function flightSentence(point: ScatterPoint, currency: string): string {
  const parts = [
    `${flightName(point)}${point.airlineName ? `, ${point.airlineName}` : ''}`,
    `departs ${formatStamp(point.departureAt)}`,
    stopsLabel(point.transfers),
    formatDuration(point.durationMinutes),
    formatMoney(point.price, currency),
  ];
  if (point.cheapestOfDay) parts.push('cheapest flight of its day');
  return `${parts.join('. ')}.`;
}
