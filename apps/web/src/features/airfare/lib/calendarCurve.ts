import { formatFlightDate } from '@/features/airfare/data/fareRoutes';

/**
 * What a booking horizon is, reduced to the two facts the rest of the page
 * still asks it for.
 *
 * **This module used to gather a curve into periods and describe them.** It
 * built weeks and months out of 331 departure dates, summarised each into a
 * band and a median, counted the two kinds of absence inside it and wrote the
 * sentence a crosshair read out — everything a whole-horizon chart needed to
 * draw the year in one frame.
 *
 * That chart is gone with the zoom it was the far end of. A curve date is now
 * drawn as itself, on the same frame as the boards, wherever the frame reaches
 * past the watched month: one price for one date, never folded into a week's
 * median. So the folding is not simplified here, it is deleted — the aggregate
 * a reader would have been shown was an average over dates each of which is now
 * on screen in its own right, and keeping the machinery would have left two
 * answers to "what does this week cost" with nothing to choose between them.
 *
 * What survives is the two things that were never about periods: which dates a
 * window covers, and when the curve on screen was collected.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Every calendar date from one to another, inclusive.
 *
 * `Date.parse` on an explicit `Z` and read back with `toISOString`, never
 * `new Date('2026-08-19')` in local time: the latter is midnight UTC and reads
 * as the 18th for this app's default reader in Lima, which would shift the
 * whole horizon by a day and put every price on the wrong departure.
 */
export function eachDate(from: string, to: string): string[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const dates: string[] = [];
  for (let at = start; at <= end; at += DAY_MS) {
    dates.push(new Date(at).toISOString().slice(0, 10));
  }
  return dates;
}

/**
 * The collection stamp as written, never reparsed.
 *
 * `capturedAt` is an instant with an offset, and the rest of this feature reads
 * such stamps by slicing rather than by `new Date`, so a reader west of
 * Greenwich is not shown the previous day. Slicing keeps the stamp's own clock,
 * which is the one the collector wrote. It matters more here than on the boards:
 * a curve is written only when something moved, so the one on screen may be
 * weeks old and the reader has to be able to see that.
 */
export function collectedAtLabel(capturedAt: string): string {
  const day = capturedAt.slice(0, 10);
  const clock = capturedAt.slice(11, 16);
  return /^\d{4}-\d{2}-\d{2}$/.test(day)
    ? `${formatFlightDate(day)}${/^\d{2}:\d{2}$/.test(clock) ? ` ${clock}` : ''}`
    : capturedAt;
}
