import { bucketKey, periodBounds, type Granularity } from '@/features/airfare/lib/buckets';
import { eachDate } from '@/features/airfare/lib/calendarCurve';
import {
  firstDayIn,
  windowDays,
  type ScatterWindow,
  type WatchedRange,
} from '@/features/airfare/lib/flightScatter';
import type { CalendarCurve, CalendarPoint } from '@/shared/api/fares';

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

/**
 * Whether a departure date is one the boards cover — in **any** watched month.
 *
 * A watch holds several months, so this takes a list and asks whether the date
 * falls in one of them. Empty means nothing is watched and the whole frame
 * belongs to the curve; that is the one spelling of nothing, replacing the
 * `null` this took when a watch was a single range, for the reason
 * `onViewportChange` already gives about having one spelling for it.
 *
 * The ranges are deliberately **not** coalesced when two watched months are
 * adjacent. `sourceSeams` already detects changes between dates,
 * so joining the ranges here would duplicate that decision.
 */
export function isWatched(day: string, watched: readonly WatchedRange[]): boolean {
  // String comparison on fixed-width dates, never `Date.parse` — the rule the
  // rest of this feature keeps, and for the same reason: a parsed date is
  // midnight UTC and is the previous day for a reader in Lima.
  return watched.some((range) => day >= range.from && day <= range.to);
}

/**
 * Every date the frame covers, and which archive answers for it.
 *
 * The watched months rather than "the dates that happen to carry flights": a
 * day inside a watched month whose board came back empty is still a board day,
 * and must be drawn and marked as one rather than quietly handed to the curve,
 * which has its own separate answer for that date and would contradict it.
 *
 * That rule is why a watched month with nothing collected yet draws as empty
 * boards rather than as the curve. It is the same answer this has always given
 * for an empty day inside the open month, and the alternative — deriving the
 * watched set from the months that happen to hold snapshots — would make a
 * freshly added month flip from curve to boards mid-session, on a collection
 * the reader never pressed.
 */
export function frameDays(window: ScatterWindow, watched: readonly WatchedRange[]): FrameDay[] {
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
 * A list rather than a single offset, because a range narrower than the frame
 * puts a run of board days in the middle of a week of curve days and has a seam
 * on each side of it. Reporting only the first would draw half the boundary and
 * leave the other half looking like an ordinary midnight. Watches stopped being
 * able to build that frame at 12.260; the list stays because this reads a day
 * list rather than a watch.
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

/**
 * One curve date as it is drawn: a span rather than a point, because the price
 * is for the whole date.
 *
 * `from` and `to` are its own two midnights, so the mark is exactly as wide as
 * the day it is about and claims nothing about an hour inside it. `centre` is
 * for the absence mark and the crosshair's tag, which need one x and not two — the
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
  /** When this date's price was collected. Null where nothing answered for it. */
  observedAt: string | null;
  /**
   * True where this price was carried over from an older collection than the
   * newest one in the horizon — `a-curve-fills-what-newer-lost`.
   *
   * A separate flag rather than something the chart works out from the two
   * stamps, so the comparison is made once, in a tested function, rather than
   * in the middle of a render. Always false where nothing answered: an absence
   * has no age.
   */
  inherited: boolean;
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
 *
 * **A third fact now travels with each mark: how old its price is.** The
 * horizon is assembled from every stored curve, so a date the newest collection
 * never reached is answered by an older one and is genuinely staler than the
 * date beside it. `inherited` is that comparison, made here rather than in the
 * chart: the horizon's own `capturedAt` is the freshest observation in it, so a
 * point stamped with anything else came from an earlier pass.
 */
export function curveMarks(days: FrameDay[], curve: CalendarCurve | null): CurveMark[] {
  const pointByDate = new Map<string, CalendarPoint>();
  if (curve) {
    for (const point of curve.prices) pointByDate.set(point.departureDate, point);
  }

  return days
    .filter((day) => day.source === 'curve')
    .map((day) => {
      const inWindow = curve !== null && day.day >= curve.fromDate && day.day <= curve.toDate;
      const point = inWindow ? pointByDate.get(day.day) : undefined;
      const answered = point !== undefined;
      const from = day.index * MINUTES_PER_DAY;
      return {
        day: day.day,
        from,
        to: from + MINUTES_PER_DAY,
        centre: from + MINUTES_PER_DAY / 2,
        price: point?.price ?? null,
        answered,
        observedAt: point?.observedAt ?? null,
        // Compared against the horizon's freshest stamp rather than against
        // today: what matters to a reader is whether this figure is as new as
        // the newest thing on the same chart, not how many hours old it is.
        inherited: point !== undefined && curve !== null && point.observedAt !== curve.capturedAt,
      };
    });
}

/**
 * Every period the reader can step to, at this granularity.
 *
 * **Day never leaves the watched months.** Its keys are the departure dates the
 * boards actually carry, which are inside one watched month or another by
 * construction — because the page narrows the archive to the watch before it
 * counts them — so there is no way to arrive at a day view of a date whose only
 * price is a single timeless number, the case a 24-hour axis cannot draw
 * honestly. That guarantee now rests on `snapshotsForMonths` rather than on the
 * caller only ever holding one month, and it is worth naming: hand this the
 * pair's whole archive and the day view would reach months nobody watches.
 *
 * Week and month may leave them, and are the two views that can: a week
 * straddles a boundary and draws both resolutions, while a calendar month is
 * watched or it is not and therefore never mixes at all.
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
