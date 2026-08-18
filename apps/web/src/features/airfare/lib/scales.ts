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
