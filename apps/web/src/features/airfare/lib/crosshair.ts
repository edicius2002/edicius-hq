import {
  boundsLabel,
  periodBounds,
  type Bucket,
  type Granularity,
} from '@/features/airfare/lib/buckets';
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
  /** The short form the axis uses — `08-18`, `2026 wk 34`, `2026-08`. */
  label: string;
  /** The same period spelled out with both its boundaries. */
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
 * the reader most wants named, not hidden.
 */
export function readingAt(
  key: string,
  ours: Bucket[],
  baseline: Bucket[],
  granularity: Granularity,
): CrosshairReading | null {
  const mine = ours.find((bucket) => bucket.key === key) ?? null;
  const theirs = baseline.find((bucket) => bucket.key === key) ?? null;
  if (mine === null && theirs === null) return null;

  return {
    key,
    label: mine?.label ?? theirs?.label ?? key,
    period: boundsLabel(periodBounds(key, granularity)),
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
