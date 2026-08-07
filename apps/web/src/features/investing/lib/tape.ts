/**
 * The tape's timing and length, as arithmetic rather than as CSS.
 *
 * Both answers depend on things a stylesheet cannot see — how wide the rendered
 * group turned out to be, and how many symbols are being followed — so they
 * live here where they can be measured against a number instead of a screenshot.
 */

/**
 * How fast the tape travels, in pixels per second.
 *
 * Taken from the references rather than guessed. General marquee guidance puts
 * 40–80 px/s in the readable range and treats anything past 100 as illegible,
 * but that is guidance for *reading* a line of prose. A tape is scanned for a
 * symbol you already care about, it stops under the pointer, and every symbol
 * comes round again — so it can run harder than prose without costing anything.
 * At this speed one item takes about 1.4s to cross.
 */
export const PIXELS_PER_SECOND = 130;

/**
 * The loop translates by exactly one group's width, so a group narrower than
 * the frame would drag a visible gap across the screen. Repeating the symbols
 * up to this count makes the group wide enough on any realistic viewport
 * without having to measure one before the first paint.
 */
export const MIN_ITEMS = 12;

/** Before the group has been measured. Replaced on the first layout pass. */
export const FALLBACK_DURATION_SECONDS = 30;

/** Constant speed, whatever the symbol count or how long their names are. */
export function loopDuration(groupWidthPx: number): number {
  if (!Number.isFinite(groupWidthPx) || groupWidthPx <= 0) return FALLBACK_DURATION_SECONDS;
  return groupWidthPx / PIXELS_PER_SECOND;
}

/** Repeats the list until it is long enough to fill a frame. */
export function tapeCycle<T>(quotes: T[]): T[] {
  if (!quotes.length) return [];
  const cycle: T[] = [];
  while (cycle.length < MIN_ITEMS) cycle.push(...quotes);
  return cycle;
}
