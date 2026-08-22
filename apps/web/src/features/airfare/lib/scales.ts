import type { PricePoint } from '@/features/airfare/lib/series';

/**
 * The arithmetic behind the price chart, kept out of the component.
 *
 * Investing has a `lib/scales.ts` of its own and this is not it: features must
 * not import each other, and the two answer different questions anyway — that
 * one maps candles onto a bar-index axis with pan and zoom, this one maps a
 * short, evenly-spaced series of observations onto a fixed SVG box. Promoting
 * either into `shared/` would mean unifying them, and there is nothing here
 * that wants a zoom window.
 */

export type Viewport = {
  width: number;
  height: number;
  padding: { top: number; right: number; bottom: number; left: number };
};

export type PriceBand = {
  min: number;
  max: number;
};

/**
 * The vertical range to draw.
 *
 * Not anchored at zero. A fare series that runs 600–700 drawn from zero is a
 * flat line across the top of the box, which hides exactly the movement the
 * page exists to show. Padded by a tenth so the extremes are not on the frame,
 * and given a floor so a series that never moves still gets a band to sit in
 * rather than a zero-height one that divides by nothing.
 */
export function priceBand(points: PricePoint[]): PriceBand {
  if (points.length === 0) return { min: 0, max: 1 };

  const prices = points.map((point) => point.price);
  const low = Math.min(...prices);
  const high = Math.max(...prices);

  if (low === high) {
    const margin = Math.max(Math.abs(low) * 0.1, 1);
    return { min: low - margin, max: high + margin };
  }

  const margin = (high - low) * 0.1;
  return { min: low - margin, max: high + margin };
}

export function xAt(index: number, count: number, viewport: Viewport): number {
  const { padding, width } = viewport;
  const usable = width - padding.left - padding.right;
  // One observation sits in the middle rather than hard against the left edge,
  // where it reads as the start of a line that is not there.
  if (count <= 1) return padding.left + usable / 2;
  return padding.left + (usable * index) / (count - 1);
}

export function yAt(price: number, band: PriceBand, viewport: Viewport): number {
  const { padding, height } = viewport;
  const usable = height - padding.top - padding.bottom;
  const span = band.max - band.min || 1;
  return padding.top + usable * (1 - (price - band.min) / span);
}

/**
 * Ticks for the price axis: a few round numbers inside the band.
 *
 * Round to the series, not to the decimal system — a band of 612 to 748 gets
 * ticks at its own scale rather than at 0, 500, 1000, two of which are off the
 * chart.
 */
export function priceTicks(band: PriceBand, count = 4): number[] {
  if (count < 2) return [band.min, band.max];

  const step = (band.max - band.min) / (count - 1);
  const ticks: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ticks.push(band.min + step * index);
  }
  return ticks;
}

/* ------------------------------------------------- what a tick label says -- */

/**
 * Round numbers inside a range — the ticks the three panel charts print.
 *
 * **A tick label is read as a fare, so it must not be one we invented.** Every
 * chart on this panel pads its vertical domain before drawing — a fare series
 * hard against the frame is unreadable — and every one of them used to print
 * the padded ends and their midpoint as the axis labels. On the real horizon
 * that is $22.63, $118.79 and $214.94 against data running $41.24 to $196.33:
 * three figures nobody was ever quoted, printed in the same money format as
 * the quotes themselves and indistinguishable from them.
 *
 * Two ways out were on the table. One was to tick at observed values — but the
 * midpoint of two observations is not an observation either, and a three-tick
 * axis of real quotes would have to be three specific quotes chosen for their
 * height, which is a stranger claim than a scale. The other is this: make the
 * axis read as a *scale* rather than as a list of prices, by ticking only at
 * round numbers. $50, $100, $150, $200 cannot be mistaken for a fare somebody
 * paid, and the real extremes are stated in words — in the accessible name of
 * every chart, and in the crosshair's own readout.
 *
 * The step is a power of ten times 1, 2, 2½ or 5, chosen by trying them all and
 * keeping the one whose tick count lands nearest `target`. Picked by count
 * rather than by the usual log-distance rule because these three charts are
 * short and their bands narrow: 612 to 748 is an ordinary long-haul week, and
 * the log rule hands it a step of 50, which is two gridlines on a whole chart.
 * A tie goes to the larger step, so the axis stays as round as it can be.
 *
 * Multiples of the step rather than offsets from the low end, because a tick
 * has to be round in its own right — 22.63, 72.63, 122.63 would be evenly
 * spaced and no more honest than what it replaces.
 */
export function niceTicks(low: number, high: number, target = 4): number[] {
  if (!Number.isFinite(low) || !Number.isFinite(high) || high <= low || target < 2) {
    return [];
  }

  let best: number[] = [];
  let closest = Number.POSITIVE_INFINITY;
  for (const step of candidateSteps(high - low)) {
    const ticks = ticksEvery(step, low, high);
    const distance = Math.abs(ticks.length - target);
    // Strictly closer wins, and the candidates run largest first, so a tie
    // keeps the rounder of the two steps.
    if (distance < closest) {
      closest = distance;
      best = ticks;
    }
  }

  // A range too narrow to hold two round numbers is a range with no scale to
  // draw. Its own ends are the honest fallback — they are at least the two
  // numbers the chart is actually bounded by.
  return best.length < 2 ? [low, high] : best;
}

/**
 * The two figures a price axis may state as figures: what the frame's cheapest
 * fare actually is, and what its dearest actually is.
 *
 * **This is not the thing `niceTicks` refuses, and the difference is the whole
 * of why it is allowed.** That function refuses to *tick* at observed values,
 * because a scale made of three quotes chosen for their height is a stranger
 * claim than a scale, and because the padded ends it used to print were figures
 * nobody was ever quoted. Both objections are about numbers presented as a
 * ruler. These two are presented as what they are — the extremes of the frame,
 * each one a fare that is on the plot, drawn at its own height and never at the
 * padded end of the domain. The round ticks stay exactly as they are and stay
 * the scale.
 *
 * Read off the same array the domain was built from, so the two cannot drift
 * apart: `spanOfPrices` pads outwards from these, which is also why both are
 * always strictly inside the plot and neither can be clipped.
 *
 * Null for a frame with nothing priced on it, which is the frame that has no
 * axis either.
 */
export function observedEnds(prices: number[]): { low: number; high: number } | null {
  if (prices.length === 0) return null;
  return { low: Math.min(...prices), high: Math.max(...prices) };
}

/**
 * The ticks far enough from a stated figure to be printed beside it.
 *
 * Two labels in a 76-unit margin at ten pixels a line overprint each other long
 * before they collide numerically, and the pair that collides is exactly the
 * pair a reader needs: ARI-SCL's March frame runs $62.77 to $69.26 and its round
 * ticks fall at $62.50 and $70, both within half a dollar of an endpoint. The
 * gridline stays — the scale is not what is crowded — and only the word is
 * dropped, so nothing about the axis's spacing changes.
 *
 * `gap` is in the axis's own units rather than in view units, because this
 * function has no plot: the caller converts the height it can spare into a
 * price, which is one division at the one place that knows both.
 */
export function ticksClear(ticks: number[], stated: number[], gap: number): number[] {
  return ticks.filter((tick) => stated.every((value) => Math.abs(tick - value) >= gap));
}

/** A power of ten times one of these is a number a reader reads as round. */
const STEP_FACTORS = [5, 2.5, 2, 1];

/** Every candidate step worth trying for a range this wide, largest first. */
function candidateSteps(span: number): number[] {
  const top = Math.floor(Math.log10(span));
  const steps: number[] = [];
  for (let power = top + 1; power >= top - 2; power -= 1) {
    for (const factor of STEP_FACTORS) steps.push(factor * 10 ** power);
  }
  return steps;
}

function ticksEvery(step: number, low: number, high: number): number[] {
  const ticks: number[] = [];
  const last = Math.floor(high / step);
  for (let index = Math.ceil(low / step); index <= last; index += 1) {
    // Rebuilt from the multiple each time rather than accumulated, and rounded
    // to twelve figures, so a step of 0.1 does not drift into
    // 0.30000000000000004 by the fourth tick.
    ticks.push(Number((index * step).toPrecision(12)));
  }
  return ticks;
}

/** The `d` of a polyline through every observation. */
export function linePath(points: PricePoint[], band: PriceBand, viewport: Viewport): string {
  if (points.length === 0) return '';
  return points
    .map((point, index) => {
      const x = xAt(index, points.length, viewport).toFixed(2);
      const y = yAt(point.price, band, viewport).toFixed(2);
      return `${index === 0 ? 'M' : 'L'}${x} ${y}`;
    })
    .join(' ');
}
