import type { Position } from '@/features/investing/data/portfolio';
import type { Band } from '@/features/investing/lib/panes';
import type { Plot } from '@/features/investing/lib/scales';
import type { Bar } from '@/shared/api/market';

/**
 * A flat reference level drawn across the price band — a position's entry
 * today, a price alert tomorrow. Deliberately dumb: this layer only knows how
 * to put a dashed line and a label at a price, not what the price means or
 * why it is coloured the way it is. That judgement stays with the caller.
 */
export type PriceLine = {
  price: number;
  /** Drawn in the right-hand gutter, beside the axis ticks. */
  label: string;
  color: string;
};

export type PriceLinesArgs = {
  lines: PriceLine[];
  band: Band;
  plot: Plot;
  scale: (price: number) => number;
};

/** A longer dash than the indicator lines use, so the two are never confused. */
const DASH: [number, number] = [6, 4];

/**
 * Draws each line, or nothing at all when its price falls outside the band.
 *
 * A price is skipped rather than clamped to the edge: clamping would draw a
 * line at a level the position was never actually entered at, which is a
 * worse lie than not drawing one. The band a line is skipped against is the
 * same one `priceRange` already left this price out of, so the axis itself
 * never stretches to fit it.
 */
export function drawPriceLines(ctx: CanvasRenderingContext2D, args: PriceLinesArgs): void {
  const { lines, band, plot, scale } = args;
  if (!lines.length) return;

  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';
  ctx.lineWidth = 1;

  for (const priceLine of lines) {
    const y = scale(priceLine.price);
    if (y < band.top || y > band.top + band.height) continue;

    ctx.strokeStyle = priceLine.color;
    ctx.setLineDash(DASH);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y) + 0.5);
    ctx.lineTo(plot.width, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = priceLine.color;
    ctx.textAlign = 'left';
    ctx.fillText(priceLine.label, plot.width + 6, y);
  }
}

/**
 * Colours that already mean something on this chart: a candle closing up or
 * down. Kept local rather than imported, the same way the chart's own
 * `COLOURS` keeps its own copy of them rather than reaching into the
 * indicator layer for a palette that happens to overlap.
 */
const UP = '#8dd36f';
const DOWN = '#f08d78';
const NEUTRAL = '#b8aca0';

/**
 * The entry line for an open position: its price is the average cost paid,
 * its colour says whether the latest close sits above or below it, reusing
 * the same colours a candle already uses for up and down rather than
 * inventing a third meaning for green and red.
 */
export function positionPriceLine(bars: Bar[], position: Position): PriceLine {
  const current = bars.at(-1)?.close;
  const color = current === undefined ? NEUTRAL : current >= position.averageCost ? UP : DOWN;

  return {
    price: position.averageCost,
    label: `Entry ${position.averageCost.toFixed(2)}`,
    color,
  };
}
