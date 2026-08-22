import type { ProjectedMonth } from '@/features/greenlight/lib/compound';

/**
 * Where the ten-year curve is drawn, and which month a position on it is.
 *
 * Kept out of the component for the reason `airfare/lib/crosshair.ts` is: the
 * drawing needs a browser, the arithmetic does not, and the arithmetic is the
 * half that can be wrong without looking wrong.
 */

/**
 * The drawing's own units. Fixed, so the shape of the box it lands in cannot
 * change it.
 *
 * 640 x 360 is not arbitrary. The middle column measures **418.79 x 240** at
 * the owner's 1536-px window — measured in Chrome on 2026-08-22 — so the
 * drawing is scaled to 0.654 by its width and stands 235.6 px tall, leaving
 * 2.2 px of letterbox a side. At the 640 x 300 this started as, the same column
 * left **51.9 px of blank a side**: a third of the box's height spent on
 * nothing, in the one column of the three that is short of room.
 */
export const CURVE_VIEW = { width: 640, height: 360 };

/**
 * Room for the axis. The left margin holds a whole `formatMoney` figure —
 * `$37,075.30`, ten glyphs — because the tables beside this chart print money
 * that way and an axis that abbreviated to `$37.1k` would be the only place on
 * the page writing a point into a number the headline writes with a comma.
 * `chartFormat`'s `formatAxisMoney` does exactly that and is left alone rather
 * than adopted.
 *
 * 120 units of it rather than 88, because the drawing is scaled to 0.654 in the
 * column it lands in and a label set at 11 view units was rendering at **7.2 px
 * on screen** — measured in Chrome at the owner's 1536-px window. The label is
 * 15 units now, which is 9.8 px there, and ten glyphs of it need the wider
 * margin.
 */
export const CURVE_PAD = { top: 16, right: 20, bottom: 46, left: 120 };

export const PLOT_LEFT = CURVE_PAD.left;
export const PLOT_RIGHT = CURVE_VIEW.width - CURVE_PAD.right;
export const PLOT_TOP = CURVE_PAD.top;
export const PLOT_BOTTOM = CURVE_VIEW.height - CURVE_PAD.bottom;

/** How many horizontal rules the plot carries, floor and ceiling included. */
const TICK_COUNT = 4;

export type CurvePoint = { month: number; x: number; y: number };

export type CurveLayout = {
  points: CurvePoint[];
  path: string;
  /** The value the plot floor stands for, and the one its ceiling does. */
  floor: number;
  top: number;
  ticks: { value: number; y: number }[];
  /** View units between one month and the next. */
  step: number;
  xAt: (month: number) => number;
  yAt: (value: number) => number;
};

/**
 * The curve, placed.
 *
 * **The floor is the starting capital rather than zero, and that is a choice
 * with a measurement behind it.** Zero-floored, ten years at 6% occupies the
 * top 44.8% of the plot and its bend away from a straight line is 3.3% of the
 * full height — a line that is, to the eye, straight. Floored at the capital
 * the same curve fills the plot and bends by 7.34% of it: 22.2 view units out
 * of 302, deepest at month 63. Neither is dramatic and the second is the
 * honest one to show,
 * because the money below the floor is money that was already there and is not
 * what the section is about. The floor carries its own label so nothing is
 * being hidden by the crop.
 */
export function curveLayout(rows: ProjectedMonth[], capital: number): CurveLayout {
  const floor = capital;
  const last = rows.at(-1)?.balance ?? capital;
  const top = last > floor ? last : floor + 1;
  const span = top - floor;
  const plotW = PLOT_RIGHT - PLOT_LEFT;
  const plotH = PLOT_BOTTOM - PLOT_TOP;
  const step = rows.length > 1 ? plotW / (rows.length - 1) : 0;

  const xAt = (month: number) => PLOT_LEFT + (month - 1) * step;
  const yAt = (value: number) => PLOT_TOP + plotH * (1 - (value - floor) / span);

  const points = rows.map((row) => ({ month: row.month, x: xAt(row.month), y: yAt(row.balance) }));
  const path = points
    .map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`)
    .join(' ');

  const ticks = [];
  for (let index = 0; index < TICK_COUNT; index += 1) {
    const value = floor + (span * index) / (TICK_COUNT - 1);
    ticks.push({ value, y: yAt(value) });
  }

  return { points, path, floor, top, ticks, step, xAt, yAt };
}

/**
 * The month a horizontal position in view units names.
 *
 * **Snapped, never interpolated.** A hundred and twenty months across 532 view
 * units is 4.47 units each, so a readout that floated between them would be
 * reporting a fraction of a month — a balance on the 13th of never, and a
 * figure that appears in none of the two tables either side of the chart. Every
 * position the pointer can occupy resolves to a row the reader can go and find.
 *
 * Strictly nearer wins, so a pointer exactly on the midpoint between two months
 * resolves to the earlier one and stays there rather than flickering as the
 * hand shakes across it. That is `nearestBucket`'s rule in
 * `airfare/lib/crosshair.ts`, reproduced rather than called: months are evenly
 * spaced, so nearest is one division instead of a scan of 120 positions on
 * every pointer event, and the tie-break has to be spelled the same way for the
 * two charts to feel the same under the hand.
 */
export function monthAtView(x: number, months: number, step: number): number {
  if (months <= 1 || step <= 0) return 1;
  const index = Math.ceil((x - PLOT_LEFT) / step - 0.5);
  return Math.min(Math.max(index + 1, 1), months);
}
