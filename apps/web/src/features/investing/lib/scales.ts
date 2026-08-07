import { scaleLinear } from 'd3-scale';

import type { Bar } from '@/shared/api/market';

/**
 * The chart's coordinate maths.
 *
 * The horizontal axis is **bar index, not time**. This is the thing to get
 * right first: mapping timestamps to pixels draws every weekend and every night
 * as dead space, because nothing traded there. Terminals index by position so
 * closed sessions collapse on their own — and as a bonus the scale becomes
 * linear over integers.
 *
 * `d3-scale` is used for one job: turning a price range into round numbers a
 * human wants on an axis. That algorithm is solved, tedious, and easy to get
 * subtly wrong in a way that makes every chart look amateur.
 */

/** Which bars are on screen. Fractional, so panning is smooth rather than steppy. */
export type IndexWindow = { first: number; last: number };

export type PriceRange = { min: number; max: number };

export type Plot = { width: number; height: number };

/**
 * The zoom limits are in **pixels per bar**, not in bar counts.
 *
 * A count means different things on different screens: ten bars is a 99px
 * candle on a 1413px plot and a 42px one at 600px. What actually distorts the
 * chart is the slot getting too wide — the body swells while the wick stays a
 * hairline — or too narrow, where neighbours overlap.
 */
export const MAX_SLOT_PX = 32;

/** A floor so a very narrow plot still asks for a sane number of bars. */
export const MIN_VISIBLE_BARS = 8;

/** How much of its slot a candle body fills; the rest is the gap between bars. */
const BODY_SHARE = 0.7;

export function minVisibleBars(plot: Plot): number {
  return Math.max(MIN_VISIBLE_BARS, Math.ceil(plot.width / MAX_SLOT_PX));
}

export function clampWindow(
  window: IndexWindow,
  total: number,
  minBars = MIN_VISIBLE_BARS,
): IndexWindow {
  const span = Math.max(minBars, Math.min(window.last - window.first, total));

  // Kept inside the series, and anchored to the right when there is not enough
  // history to fill the span — a chart should end at the latest bar, not float.
  let last = Math.min(window.first + span, total);
  let first = last - span;
  if (first < 0) {
    first = 0;
    last = Math.min(span, total);
  }
  return { first, last };
}

export function visibleBars(bars: Bar[], window: IndexWindow): Bar[] {
  const from = Math.max(0, Math.floor(window.first));
  const to = Math.min(bars.length, Math.ceil(window.last));
  return bars.slice(from, to);
}

/** Bar index to horizontal pixel, at the centre of the bar's slot. */
export function xAt(index: number, window: IndexWindow, plot: Plot): number {
  const span = window.last - window.first || 1;
  return ((index - window.first + 0.5) / span) * plot.width;
}

/** Horizontal pixel back to a bar index. Used by the crosshair and by dragging. */
export function indexAt(x: number, window: IndexWindow, plot: Plot): number {
  const span = window.last - window.first || 1;
  return (x / plot.width) * span + window.first - 0.5;
}

export function slotWidth(window: IndexWindow, plot: Plot): number {
  return plot.width / (window.last - window.first || 1);
}

export function barWidth(window: IndexWindow, plot: Plot): number {
  const slot = slotWidth(window, plot);
  // A candle never quite fills its slot; the gap is what makes them read as
  // separate bars rather than a solid block. The floor keeps a candle visible
  // when zoomed right out, and the cap stops that floor overflowing its own
  // slot — past about a thousand bars the floor alone made neighbours overlap.
  return Math.min(slot, Math.max(1, slot * BODY_SHARE));
}

/**
 * How thick to draw the wick.
 *
 * Fixed at one pixel it becomes a thread stuck to a hundred-pixel body when
 * zoomed in, which is the thing that actually looks broken. It scales with the
 * body and stops growing before it becomes a second body.
 */
export function wickWidth(candle: number): number {
  return Math.max(1, Math.min(candle / 6, 6));
}

/**
 * The price range on screen.
 *
 * Ghost candles are included, as agreed: an after-hours move should be visible
 * even if it stretches the axis, and the scale re-fitting when they are cleared
 * at the open is expected rather than a fault.
 */
export function priceRange(bars: Bar[], padding = 0.06): PriceRange {
  if (!bars.length) return { min: 0, max: 1 };

  let min = Infinity;
  let max = -Infinity;
  for (const bar of bars) {
    if (bar.low < min) min = bar.low;
    if (bar.high > max) max = bar.high;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 };

  // A flat series has no range to pad, so it gets an arbitrary one rather than
  // collapsing to a single line at the top of the plot.
  if (min === max) {
    const nudge = Math.abs(min) * 0.01 || 1;
    return { min: min - nudge, max: max + nudge };
  }

  const room = (max - min) * padding;
  return { min: min - room, max: max + room };
}

export function priceScale(range: PriceRange, plot: Plot) {
  // Inverted on purpose: pixels grow downwards, prices upwards.
  return scaleLinear().domain([range.min, range.max]).range([plot.height, 0]);
}

/** Round numbers for the price axis, and never more than fit. */
export function priceTicks(range: PriceRange, plot: Plot, spacing = 48): number[] {
  const count = Math.max(2, Math.floor(plot.height / spacing));
  return scaleLinear().domain([range.min, range.max]).ticks(count);
}

/**
 * Where to put labels on the time axis.
 *
 * Returned as bar indices rather than timestamps, because the axis is indexed:
 * a label belongs to a bar, and the bar knows what time it is.
 */
export function timeTicks(window: IndexWindow, plot: Plot, spacing = 96): number[] {
  const span = window.last - window.first;
  if (span <= 0) return [];

  const wanted = Math.max(2, Math.floor(plot.width / spacing));
  const step = Math.max(1, Math.round(span / wanted));

  const ticks: number[] = [];
  // Anchored to multiples of the step so labels do not slide about while panning.
  const start = Math.ceil(window.first / step) * step;
  for (let index = start; index < window.last; index += step) {
    if (index >= 0) ticks.push(index);
  }
  return ticks;
}

/**
 * Zoom about a point, in index space.
 *
 * The bar under the pointer stays under it, the same rule the Finance camera
 * follows — without it the chart slides away from what you were looking at.
 */
export function zoomWindow(
  window: IndexWindow,
  factor: number,
  pivotIndex: number,
  total: number,
  minBars = MIN_VISIBLE_BARS,
): IndexWindow {
  const span = window.last - window.first;
  const next = Math.max(minBars, Math.min(span * factor, Math.max(total, minBars)));

  // The half-bar is not decoration: `xAt` draws a bar at the centre of its slot,
  // and the slot changes width as you zoom. Preserving the index's share of the
  // window without it moves the candle half a slot per step, which accumulates
  // into the chart sliding out from under the pointer.
  const share = span === 0 ? 0.5 : (pivotIndex - window.first + 0.5) / span;
  const first = pivotIndex + 0.5 - share * next;
  return clampWindow({ first, last: first + next }, total, minBars);
}

export function panWindow(
  window: IndexWindow,
  byBars: number,
  total: number,
  minBars = MIN_VISIBLE_BARS,
): IndexWindow {
  return clampWindow({ first: window.first + byBars, last: window.last + byBars }, total, minBars);
}
