import type { Bucket, BucketAxis, UnsoldPeriod } from '@/features/airfare/lib/buckets';
import { NO_VALUE, formatMoney } from '@/shared/lib/money';

/**
 * The arithmetic behind the price chart's crosshair, kept out of the component.
 *
 * Three questions, none of which needs a browser to answer: which period the
 * pointer is nearest, what that period actually holds, and where a label can
 * sit without hanging off the edge of the plot. The component does the drawing
 * and the event handling; everything a test would want to assert about is here,
 * for the same reason `flightTable.ts` and `series.ts` are.
 */

/**
 * The period nearest a horizontal position, by index.
 *
 * Snapping rather than interpolating is the whole reason this exists. The
 * series has gaps — a collector that missed two days leaves two days with no
 * bucket at all — and a readout that floated between periods would print a
 * price for a day nobody looked at. Nearest also means the pointer never has
 * to land on a three-pixel dot to read it.
 *
 * Strictly nearer wins, so a pointer exactly halfway between two periods
 * resolves to the earlier one and stays there instead of flickering as the
 * hand shakes across the midpoint.
 */
export function nearestBucket(positions: number[], x: number): number | null {
  let best: number | null = null;
  let shortest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < positions.length; index += 1) {
    const distance = Math.abs(positions[index] - x);
    if (distance < shortest) {
      shortest = distance;
      best = index;
    }
  }
  return best;
}

/** Everything the chart is drawing at one period, as one object to render. */
export type CrosshairReading = {
  key: string;
  /** The short form the axis uses — `08-18`, `2026 wk 34`, `189–195d ahead`. */
  label: string;
  /** The same period spelled out — both its clocks, or both its lead days. */
  period: string;
  /** Our own band and its middle, or null where only the provider has a figure. */
  ours: { low: number; high: number; middle: number; count: number } | null;
  /** The provider's daily baseline for this period, when it reaches this far back. */
  baseline: number | null;
  /**
   * Boards we asked for in this period that came back with nothing on sale —
   * 12.232. Zero on a period where every look found something, which is the
   * ordinary case and reads as no clause at all.
   */
  unsold: number;
};

/**
 * What sits under the crosshair at one period.
 *
 * Both series are looked up by key rather than by index, because they are not
 * the same length and never have been: the provider ships sixty days of
 * history and our own archive starts the day a route was added, so index 3 of
 * one is not index 3 of the other. A period drawn from only one of them is a
 * real period and gets a reading with the other half null — that is the case
 * the reader most wants named, not hidden. On the lead-time axis that is the
 * common case rather than the edge: 60 of that axis's 91 buckets are lead
 * times our own collector has never reached, and every one of them has to read
 * as "not observed" rather than borrow the figure drawn beside it.
 *
 * The period is spelled by the axis rather than by `periodBounds` — 12.170.
 * A lead-time key names whole days before departure and has no clocks to
 * state, and a chart that assumed a calendar here would caption it with one.
 */
export function readingAt(
  key: string,
  ours: Bucket[],
  baseline: Bucket[],
  axis: BucketAxis,
  unsold: UnsoldPeriod[] = [],
): CrosshairReading | null {
  const mine = ours.find((bucket) => bucket.key === key) ?? null;
  const theirs = baseline.find((bucket) => bucket.key === key) ?? null;
  // A period whose only content is empty boards is still a period the reader
  // can land on — 12.232. It is on the axis because we looked, and a crosshair
  // that vanished over its own mark would be the chart declining to say what
  // the mark meant.
  const none = unsold.find((period) => period.key === key) ?? null;
  if (mine === null && theirs === null && none === null) return null;

  return {
    key,
    label: mine?.label ?? theirs?.label ?? none?.label ?? key,
    period: axis.spell(key),
    ours:
      mine === null
        ? null
        : { low: mine.low, high: mine.high, middle: mine.middle, count: mine.count },
    baseline: theirs?.middle ?? null,
    unsold: none?.count ?? 0,
  };
}

/**
 * The reading as a sentence, for the live region.
 *
 * A crosshair that only draws is a crosshair half the readers of this page
 * cannot use, and an `aria-live` region needs prose rather than a grid. The
 * numbers go through `shared/lib/money` like every other figure in the app,
 * and a period the provider never reached says so with `NO_VALUE` instead of
 * dropping the clause — a missing baseline is a fact about the baseline.
 */
export function readingSentence(reading: CrosshairReading, currency: string): string {
  const parts = [`${reading.label}, ${reading.period}`];

  if (reading.ours === null) {
    /*
     * Two different sentences, because they are two different facts — 12.232.
     * "Nothing of our own observed" is a statement about the collector; a board
     * that came back empty is a statement about the route, and telling a reader
     * the first when the second is true has them believing nobody has looked at
     * a day the provider has already said it has nothing to sell on.
     */
    parts.push(
      reading.unsold > 0
        ? `nothing on sale — ${reading.unsold} board${reading.unsold === 1 ? '' : 's'} came back empty`
        : 'nothing of our own observed',
    );
  } else {
    const { low, high, middle, count } = reading.ours;
    parts.push(
      `${formatMoney(low, currency)} to ${formatMoney(high, currency)}, median ${formatMoney(middle, currency)}, across ${count} observation${count === 1 ? '' : 's'}`,
    );
    // A period can hold both — some looks found a board and some found none —
    // and the second half is not implied by the first.
    if (reading.unsold > 0) {
      parts.push(
        `${reading.unsold} further board${reading.unsold === 1 ? '' : 's'} came back with nothing on sale`,
      );
    }
  }

  parts.push(
    reading.baseline === null
      ? `provider baseline ${NO_VALUE}`
      : `provider baseline ${formatMoney(reading.baseline, currency)}`,
  );

  return `${parts.join('. ')}.`;
}

/* ------------------------------------------------ the price on the axis -- */

/**
 * Which of the two series a price on the axis came from.
 *
 * The chart draws two things that are both money and are not the same
 * measurement: our own median, from however many boards we caught in that
 * period, and the provider's daily baseline — one rounded integer, cheapest
 * only, no airline and no departure time. A plate that prints a figure from
 * either without saying which is a plate that changes meaning by the day and
 * never mentions it.
 */
export type AxisPriceSource = 'ours' | 'baseline';

/** A figure the price axis can name, and the series it was read from. */
export type AxisPrice = { value: number; source: AxisPriceSource };

/**
 * The one price the axis plate shows: ours when we have it, the provider's when
 * we do not.
 *
 * **Ours wins wherever it exists, and there is never a second plate.** Our
 * median is a median of real boards we polled and it is the figure the solid
 * line is drawn at, so where it exists it is the better answer and the axis
 * would be lying by pointing anywhere else. Drawing both at once was rejected:
 * two plates in a 76-unit margin overlap whenever the two series are close,
 * which on this data is most days, and the reader is then looking at two prices
 * with no way to tell which hairline belongs to which.
 *
 * The fallback exists because the alternative shipped and showed nothing. Our
 * archive starts the day a route is watched and the provider ships sixty days
 * behind it, so on most dates of chart A there is no median at all — the plate
 * was absent across nearly the whole series, and a readout that is usually
 * blank is one nobody learns to read. The baseline has a figure on nearly every
 * date. It is a worse number and it is a real one.
 *
 * Null where neither series reached the period. That is the case 12.234 was
 * written for and it is untouched: a period with nothing behind it still gets
 * no horizontal hairline and no plate, because the only remaining source for
 * one would be the pointer's own height.
 */
export function axisPrice(reading: CrosshairReading | null): AxisPrice | null {
  if (reading === null) return null;
  if (reading.ours !== null) return { value: reading.ours.middle, source: 'ours' };
  if (reading.baseline !== null) return { value: reading.baseline, source: 'baseline' };
  return null;
}

/**
 * What to call each series in prose, so the words match the ink.
 *
 * Kept here rather than in the component because the live region, the readout
 * strip and the chart's accessible name all have to say the same thing, and
 * three string literals in three places is how they stop saying it.
 */
export const AXIS_PRICE_WORDS: Record<AxisPriceSource, string> = {
  ours: 'our median',
  baseline: 'the provider’s baseline',
};

/**
 * The axis plate, said out loud.
 *
 * A separate sentence rather than a clause spliced into `readingSentence`,
 * because the two answer different questions: that one reports the period, this
 * one reports what the plate beside the reader's hairline currently is. A
 * period with no figure at all draws no plate, and gets no sentence rather than
 * a sentence about an absent plate — the reading itself already says the
 * period holds nothing.
 */
export function axisPriceSentence(price: AxisPrice | null, currency: string): string {
  if (price === null) return '';
  return `Price axis shows ${AXIS_PRICE_WORDS[price.source]}, ${formatMoney(price.value, currency)}.`;
}

/**
 * Where a label pinned to a hairline starts, so the box stays inside the plot.
 *
 * Centred on the hairline until one end would leave the track, then flush
 * against that end. The alternative was to let the box overhang and rely on
 * the SVG clipping it, which loses the digits that matter: the first period on
 * the axis is exactly the one whose label would be cut in half.
 *
 * A track too short for the box returns its start rather than a negative
 * offset — a label wider than the space it labels is a layout problem, and
 * pushing it off the left edge would not report it.
 */
export function clampToTrack(centre: number, size: number, start: number, end: number): number {
  if (end - start <= size) return start;
  return Math.min(Math.max(centre - size / 2, start), end - size);
}

/* --------------------------------------------------------------- the tags -- */

/**
 * How wide a label is, near enough to draw a plate behind it.
 *
 * Six view units a character, measured against the 10px axis font in a
 * 760-unit viewBox. Checked in a browser afterwards: `07-27` is predicted at
 * 30 units and its real `getBBox().width` is 29.5, so the estimate is sound
 * and there is no reason to reach for `getComputedTextLength` — which jsdom
 * does not implement, and which would force a measure-then-draw pass on a
 * value that moves with every pointer event.
 */
export const TAG_CHAR_WIDTH = 6;

/** A floor, so a two-character label still gets a plate rather than a sliver. */
export const TAG_MIN_WIDTH = 40;

/** Breathing room either side of the glyphs. */
export const TAG_PADDING = 10;

export function tagWidth(label: string): number {
  return Math.max(TAG_MIN_WIDTH, label.length * TAG_CHAR_WIDTH + TAG_PADDING);
}

export type TagAnchor = 'start' | 'middle' | 'end';

/**
 * A plate and the label that sits on it, as one object.
 *
 * The two travel together because separating them is how this went wrong the
 * first time: the plate was placed for a centred label while the label was
 * drawn end-anchored, and the leading `0` of `07-27` was painted nine units
 * outside the plate onto the dark plot, where it was invisible. Measured in
 * the live SVG — plate 466.9→506.9, glyphs 457.6→487.1. A caller that takes
 * `x`, `width`, `textX` and `anchor` from one function cannot reintroduce that
 * mismatch by changing one of them.
 */
export type AxisTag = {
  /** Left edge of the plate. */
  x: number;
  width: number;
  /** Where the label is anchored — only meaningful together with `anchor`. */
  textX: number;
  /** The anchor the label must actually be drawn with. */
  anchor: TagAnchor;
};

/**
 * The tag pinned to the time axis, centred on the hairline.
 *
 * Centred plate, centred label: the two agree by construction, and centring is
 * also what keeps the tag on the plot at the ends of the series, where a plate
 * hung from the hairline would slide off. The clamping is `clampToTrack`'s, so
 * the first and last periods get a whole label rather than a bisected one.
 */
export function timeAxisTag(centre: number, label: string, start: number, end: number): AxisTag {
  const width = tagWidth(label);
  const x = clampToTrack(centre, width, start, end);
  return { x, width, textX: x + width / 2, anchor: 'middle' };
}

/**
 * The tag pinned to the price axis, filling the margin left of the plot.
 *
 * Right-aligned against a fixed edge rather than centred on a hairline,
 * because this one does not travel along its axis — the pointer moves it up
 * and down, never sideways, so the plate can simply fill the margin. That is
 * why this tag survived the anchor mix-up that broke the time one.
 *
 * The margin has to be wide enough for the widest figure the chart can print,
 * and that is a currency question rather than a layout one: this app's default
 * origin is Lima, `formatMoney` writes soles as `S/`, and a long-haul fare in
 * soles is `S/4,580.00` — eleven glyphs where a dollar fare of the same route
 * is nine. A plate sized for `$139.00` clips the `S` off the front of that and
 * paints it outside the viewBox, which is the reported time-axis bug wearing a
 * different hat. So the plate reports the width it needs and the caller is
 * expected to have left it that much room; `marginForPrices` is how the
 * viewport works that out.
 */
export function priceAxisTag(right: number, label: string, inset = 2): AxisTag {
  const width = Math.max(TAG_MIN_WIDTH, Math.min(right, tagWidth(label)));
  return { x: right - width, width, textX: right - inset, anchor: 'end' };
}

/**
 * The widest money figure this chart is expected to print, in view units.
 *
 * Used to size the left padding rather than guessed at. `S/12,458.00` is the
 * pessimistic case — a five-figure fare in the currency whose symbol is two
 * characters — and everything narrower fits behind it.
 */
export const WIDEST_PRICE_LABEL = 'S/12,458.00';

/** How much left margin a price axis needs to hold its own labels. */
export function marginForPrices(gap: number): number {
  return tagWidth(WIDEST_PRICE_LABEL) + gap;
}

/**
 * Where the glyphs actually land, given the anchor they are drawn with.
 *
 * The point of having this at all is that a test can assert the plate contains
 * its label. jsdom has no `getBBox`, so the rendered box cannot be measured
 * there — but the placement is pure arithmetic, and arithmetic is exactly what
 * a test can pin.
 */
export function labelSpan(tag: AxisTag, textWidth: number): { from: number; to: number } {
  if (tag.anchor === 'start') return { from: tag.textX, to: tag.textX + textWidth };
  if (tag.anchor === 'end') return { from: tag.textX - textWidth, to: tag.textX };
  return { from: tag.textX - textWidth / 2, to: tag.textX + textWidth / 2 };
}

/** Whether a label of this width fits on its own plate. */
export function tagHoldsLabel(tag: AxisTag, textWidth: number): boolean {
  const span = labelSpan(tag, textWidth);
  return span.from >= tag.x && span.to <= tag.x + tag.width;
}
