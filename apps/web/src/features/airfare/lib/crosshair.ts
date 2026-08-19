import type { Bucket, BucketAxis } from '@/features/airfare/lib/buckets';
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
): CrosshairReading | null {
  const mine = ours.find((bucket) => bucket.key === key) ?? null;
  const theirs = baseline.find((bucket) => bucket.key === key) ?? null;
  if (mine === null && theirs === null) return null;

  return {
    key,
    label: mine?.label ?? theirs?.label ?? key,
    period: axis.spell(key),
    ours:
      mine === null
        ? null
        : { low: mine.low, high: mine.high, middle: mine.middle, count: mine.count },
    baseline: theirs?.middle ?? null,
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
    parts.push('nothing of our own observed');
  } else {
    const { low, high, middle, count } = reading.ours;
    parts.push(
      `${formatMoney(low, currency)} to ${formatMoney(high, currency)}, median ${formatMoney(middle, currency)}, across ${count} observation${count === 1 ? '' : 's'}`,
    );
  }

  parts.push(
    reading.baseline === null
      ? `provider baseline ${NO_VALUE}`
      : `provider baseline ${formatMoney(reading.baseline, currency)}`,
  );

  return `${parts.join('. ')}.`;
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
