import { bucketKey, periodBounds, type Granularity } from '@/features/airfare/lib/buckets';
import { eachDate } from '@/features/airfare/lib/calendarCurve';
import {
  firstDayIn,
  windowDays,
  type ScatterWindow,
  type WatchedRange,
} from '@/features/airfare/lib/flightScatter';
import type { CalendarCurve } from '@/shared/api/fares';

/**
 * Which archive answers for each departure date in one frame, and what the
 * dates the boards cannot speak for look like when they are drawn beside them.
 *
 * **The source is chosen by the date, not by a control.** Inside the month a
 * route is watched, the archive holds every itinerary at the hour it departs —
 * carrier, stops, price. Outside it there is one number per departure date and
 * nothing else: the calendar curve, which is what makes the other eleven months
 * visible at all. Those were two charts behind a zoom; the zoom is gone, and a
 * period that straddles the end of the watched month now draws both in one
 * frame, per day, because that is the period a reader actually steps onto when
 * they walk out of the month.
 *
 * **A curve date has no time of day, so the axis stops being a clock where the
 * month ends.** Up to the last watched date the x axis is hours and every
 * itinerary sits on its own; past it the axis is dates and each one carries a
 * single mark spanning the whole day. One frame, one axis, two resolutions, and
 * the change of resolution happens exactly where the change of source does —
 * `sourceSeams` is where that boundary is, and it is drawn rather than left for
 * the reader to infer. The rejected alternative was to place a curve day at
 * midnight or at noon: both are a departure time the data does not have, which
 * is the class of defect this panel spent a release removing.
 *
 * Every date keeps its own share of the frame whichever answers for it, so the
 * geometry the boards were drawn with is untouched — `xOf` still maps window
 * minutes, and a curve day is the 1,440 minutes of its own date rather than a
 * point inside them.
 */

const MINUTES_PER_DAY = 1440;

/** Which archive answers for one departure date. */
export type DaySource = 'board' | 'curve';

export type FrameDay = {
  day: string;
  /** Position in the window, in whole days from its first date. */
  index: number;
  source: DaySource;
};

/** Whether a departure date is one the boards cover. */
export function isWatched(day: string, watched: WatchedRange | null): boolean {
  // String comparison on fixed-width dates, never `Date.parse` — the rule the
  // rest of this feature keeps, and for the same reason: a parsed date is
  // midnight UTC and is the previous day for a reader in Lima.
  return watched !== null && day >= watched.from && day <= watched.to;
}

/**
 * Every date the frame covers, and which archive answers for it.
 *
 * The watched range rather than "the dates that happen to carry flights": a day
 * inside the month whose board came back empty is still a board day, and must
 * be drawn and marked as one rather than quietly handed to the curve, which has
 * its own separate answer for that date and would contradict it.
 */
export function frameDays(window: ScatterWindow, watched: WatchedRange | null): FrameDay[] {
  return windowDays(window).map((day, index) => ({
    day,
    index,
    source: isWatched(day, watched) ? 'board' : 'curve',
  }));
}

/** What a frame is drawing, which is what the chart calls itself. */
export type FrameSource = 'none' | 'boards' | 'curve' | 'mixed';

export function frameSource(days: FrameDay[]): FrameSource {
  if (days.length === 0) return 'none';
  const boards = days.some((day) => day.source === 'board');
  const curve = days.some((day) => day.source === 'curve');
  if (boards && curve) return 'mixed';
  return boards ? 'boards' : 'curve';
}

/**
 * Where the answer changes hands, in window minutes.
 *
 * A list rather than a single offset, because a watch narrowed to one departure
 * date puts a single board day in the middle of a week of curve days and has a
 * seam on each side of it. Reporting only the first would draw half the boundary
 * and leave the other half looking like an ordinary midnight.
 *
 * The offset is the midnight the change happens *at*, so the rule lands on the
 * separator between the two days rather than inside either of them.
 */
export function sourceSeams(days: FrameDay[]): number[] {
  const seams: number[] = [];
  for (let index = 1; index < days.length; index += 1) {
    if (days[index].source !== days[index - 1].source) seams.push(index * MINUTES_PER_DAY);
  }
  return seams;
}

/** A stretch of consecutive dates one archive answers for, in whole days from the frame's start. */
export type SourceRun = { source: DaySource; from: number; to: number };

/**
 * The frame cut into stretches of one source.
 *
 * `to` is exclusive, so a run's own width is `to - from` days. There can be
 * three of them rather than two, and that is not a curiosity: a watch narrowed
 * to one departure date puts a single board day in the middle of a week, with
 * curve dates on each side of it. `sourceSeams` draws both boundaries; what is
 * labelled is decided by `railLabels`, which does not label runs.
 */
export function sourceRuns(days: FrameDay[]): SourceRun[] {
  const runs: SourceRun[] = [];
  for (const day of days) {
    const last = runs.at(-1);
    if (last && last.source === day.source) last.to = day.index + 1;
    else runs.push({ source: day.source, from: day.index, to: day.index + 1 });
  }
  return runs;
}

/* ------------------------------------------------------------- the rail -- */

/**
 * How wide one glyph of the source rail is, in view units.
 *
 * Measured rather than estimated, in a browser against the live chart: the rail
 * is set at 9px in a 760-unit viewBox, and `getComputedTextLength` reports
 * `one price a date` (16 glyphs) at 87.3 and `every flight, at the hour it
 * departs` (36 glyphs) at 196.3 — 5.456 and 5.453 a glyph. 5.45 is that, and
 * the alternative of measuring at draw time is not available anyway: jsdom does
 * not implement `getComputedTextLength`, so a rule that depended on it could
 * not be tested at all.
 */
export const RAIL_CHAR_WIDTH = 5.45;

/**
 * What each archive is called on the rail, at two lengths.
 *
 * The short forms are not abbreviations of the long ones for the sake of it:
 * they have to survive being the only thing a reader sees, so each still names
 * the unit its side of the axis is drawn in — an hour on one side, a date on
 * the other, which is the whole distinction the rail exists to carry.
 */
const RAIL_WORDS: Record<DaySource, { full: string; short: string }> = {
  board: { full: 'every flight, at the hour it departs', short: 'flights, by hour' },
  curve: { full: 'one price a date', short: 'one a date' },
};

export type RailLabel = {
  source: DaySource;
  text: string;
  /** Centre of the label, in view units from the left edge of the plot. */
  centre: number;
  /** How wide it will be drawn, so a caller — or a test — can check it fits. */
  width: number;
};

function railWidth(text: string): number {
  return text.length * RAIL_CHAR_WIDTH;
}

/** Where a centred box of this width sits once it is kept inside the track. */
function clampCentre(centre: number, width: number, track: number): number {
  if (width >= track) return track / 2;
  return Math.min(Math.max(centre, width / 2), track - width / 2);
}

/**
 * Which archive answered where, as at most one label per archive.
 *
 * **One label per source, not one per run, and that is the fix for a defect
 * found in a browser.** Labelling every run put a second `one price a date`
 * under the tail of `every flight, at the hour it departs` and drew the two
 * through each other: on the owner's own ARI-SCL, whose watch is narrowed to
 * one departure date, the week of 1-7 March is three runs — curve, board, curve
 * — and the third run's label was centred 94 units from the second's, which is
 * 47 units less than half their combined width. The rail failed silently there:
 * it did not look broken, it looked like garbled text under the axis, which is
 * worse. Repeating a source's name was never worth anything either — the rail
 * answers "which archive answers where", and saying "one price a date" twice
 * says nothing the seams have not already said.
 *
 * Each label goes on its source's **widest** run, which is the stretch with the
 * most room and the one a reader's eye goes to. It takes the longest wording
 * that fits inside that run, and where even the short form does not fit it is
 * still drawn, overhanging: a label centred on a one-date stretch between two
 * seams still points at it, and dropping the name of the only stretch that is
 * hard to identify from its marks would be the rail failing at its job.
 *
 * What is never allowed is two labels crossing. The guard below is enforced
 * rather than argued from the geometry: shorten both, and if the short forms
 * still cross, keep the source that covers more of the frame — on a tie the
 * boards, because a bar is legible as a whole-date price on its own while a
 * column of dots needs the clock named before it means anything.
 */
export function railLabels(days: FrameDay[], track: number): RailLabel[] {
  const runs = sourceRuns(days);
  if (runs.length === 0 || track <= 0) return [];
  const unit = track / days.length;

  const chosen = new Map<DaySource, { run: SourceRun; dates: number }>();
  for (const run of runs) {
    const dates = run.to - run.from;
    const held = chosen.get(run.source);
    // Strictly wider wins, so a tie keeps the earlier run and the rail does not
    // jump between two equal stretches as the reader steps.
    if (!held || dates > held.dates) chosen.set(run.source, { run, dates });
  }

  type Placed = RailLabel & { dates: number };
  const place = (
    source: DaySource,
    entry: { run: SourceRun; dates: number },
    short: boolean,
  ): Placed => {
    const words = RAIL_WORDS[source];
    const fits = railWidth(words.full) <= entry.dates * unit;
    const text = !short && fits ? words.full : words.short;
    const width = railWidth(text);
    const centre = clampCentre(((entry.run.from + entry.run.to) / 2) * unit, width, track);
    return { source, text, centre, width, dates: entry.dates };
  };

  const crossing = (labels: Placed[]) =>
    labels.some((label, index) => {
      const next = labels[index + 1];
      return next !== undefined && next.centre - next.width / 2 < label.centre + label.width / 2;
    });

  const drawn = (labels: Placed[]): RailLabel[] =>
    labels.map((label) => ({
      source: label.source,
      text: label.text,
      centre: label.centre,
      width: label.width,
    }));

  const laid = (short: boolean) =>
    [...chosen.entries()]
      .map(([source, entry]) => place(source, entry, short))
      .sort((a, b) => a.centre - b.centre);

  const spread = laid(false);
  if (!crossing(spread)) return drawn(spread);

  const tight = laid(true);
  if (!crossing(tight)) return drawn(tight);

  return drawn([
    tight.reduce((best, label) =>
      label.dates > best.dates || (label.dates === best.dates && label.source === 'board')
        ? label
        : best,
    ),
  ]);
}

/**
 * One curve date as it is drawn: a span rather than a point, because the price
 * is for the whole date.
 *
 * `from` and `to` are its own two midnights, so the mark is exactly as wide as
 * the day it is about and claims nothing about an hour inside it. `centre` is
 * for the rail mark and the crosshair's tag, which need one x and not two — the
 * same middle-of-the-day placement `absentDays` already uses, and for the same
 * reason: a mark on a midnight sits on the separator between two dates and
 * reads as belonging to neither.
 */
export type CurveMark = {
  day: string;
  from: number;
  to: number;
  centre: number;
  /** The cheapest fare for this departure date, or null where there is none. */
  price: number | null;
  /** True where an answer came back — priced or explicitly nothing on sale. */
  answered: boolean;
};

/**
 * The curve dates of one frame, priced or absent.
 *
 * The two absences of the horizon survive the trip and stay apart. A date
 * inside the curve's own window carrying `null` was answered about and had
 * nothing to sell; a date the curve does not reach — because the row stops
 * short of it, or because this route has no curve at all — was never answered
 * for. Collapsing them would tell a reader a route is sold out on a day nobody
 * has ever asked about.
 *
 * Dates outside the curve's stated window are ignored rather than trusted: a
 * row whose prices reach past its own `toDate` disagrees with itself, and the
 * window is the half that says which dates were asked about.
 */
export function curveMarks(days: FrameDay[], curve: CalendarCurve | null): CurveMark[] {
  const priceByDate = new Map<string, number | null>();
  if (curve) {
    for (const point of curve.prices) priceByDate.set(point.departureDate, point.price);
  }

  return days
    .filter((day) => day.source === 'curve')
    .map((day) => {
      const inWindow = curve !== null && day.day >= curve.fromDate && day.day <= curve.toDate;
      const answered = inWindow && priceByDate.has(day.day);
      const from = day.index * MINUTES_PER_DAY;
      return {
        day: day.day,
        from,
        to: from + MINUTES_PER_DAY,
        centre: from + MINUTES_PER_DAY / 2,
        price: answered ? (priceByDate.get(day.day) ?? null) : null,
        answered,
      };
    });
}

/**
 * Every period the reader can step to, at this granularity.
 *
 * **Day never leaves the watched month.** Its keys are the departure dates the
 * boards actually carry, which are inside the month by construction, so there
 * is no way to arrive at a day view of a date whose only price is a single
 * timeless number — the case a 24-hour axis cannot draw honestly. Week and
 * month may leave it, and are the two views that can: a week straddles the
 * boundary and draws both resolutions, while a calendar month is either the
 * watched one or it is not and therefore never mixes at all.
 *
 * The union is of what the boards hold and what the curve's window covers, so a
 * route with no curve on disk simply has nothing outside its month to step to —
 * which is the truthful answer for that route rather than a page of empty
 * frames.
 */
export function framePeriodKeys(
  boardDays: string[],
  curve: CalendarCurve | null,
  granularity: Granularity,
): string[] {
  const keys = new Set(boardDays.map((day) => bucketKey(day, granularity)));
  if (granularity !== 'day' && curve !== null) {
    for (const date of eachDate(curve.fromDate, curve.toDate)) {
      keys.add(bucketKey(date, granularity));
    }
  }
  return [...keys].sort((a, b) => a.localeCompare(b));
}

/**
 * The departure date a step onto a period should anchor on.
 *
 * A day the boards hold where the period has one, so a later flip to the day
 * view lands on a date that exists there rather than falling back to the start
 * of the month. Where the period holds no board day — every period outside the
 * watched month — the period's own first calendar date, which is enough for
 * `activeKey` to resolve the same period again and is the only date the frame
 * can name.
 */
export function anchorFor(key: string, granularity: Granularity, boardDays: string[]): string {
  return (
    firstDayIn(boardDays, key, granularity) ?? periodBounds(key, granularity).from.slice(0, 10)
  );
}
