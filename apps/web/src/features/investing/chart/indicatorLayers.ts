import { extentOf, RSI_PERIOD } from '@/features/investing/lib/indicators';
import { valueToY, type Band, type PaneId } from '@/features/investing/lib/panes';
import { xAt, type IndexWindow, type Plot } from '@/features/investing/lib/scales';

/**
 * Drawing the indicators, on the same canvas as the candles.
 *
 * Every series here is a `Float64Array` indexed by bar, so a line is walked
 * with a `for` over the visible window and nothing is searched or allocated per
 * frame. `NaN` is how a series says it cannot speak for a bar yet, and it
 * breaks the path rather than drawing a leg to zero.
 */

export type IndicatorSeries = {
  /** Raw traded volume, index-aligned like the rest. Not a study — the bars' own. */
  volume?: Float64Array;
  sma?: Float64Array;
  ema?: Float64Array;
  bollinger?: { basis: Float64Array; upper: Float64Array; lower: Float64Array };
  vwap?: Float64Array;
  rsi?: Float64Array;
  macd?: { macd: Float64Array; signal: Float64Array; histogram: Float64Array };
};

export const INDICATOR_COLOURS = {
  sma: '#d6a65d',
  ema: '#7fb8d6',
  bollinger: 'rgba(214, 166, 93, 0.55)',
  bollingerFill: 'rgba(214, 166, 93, 0.06)',
  vwap: '#c79bd6',
  volume: 'rgba(141, 211, 111, 0.45)',
  volumeDown: 'rgba(240, 141, 120, 0.45)',
  rsi: '#7fb8d6',
  rsiGuide: 'rgba(255, 255, 255, 0.12)',
  macd: '#7fb8d6',
  signal: '#d6a65d',
  up: '#8dd36f',
  down: '#f08d78',
  grid: 'rgba(255, 255, 255, 0.06)',
  axis: '#b8aca0',
};

type Range = { from: number; to: number };

/** Only the bars on screen are ever walked; the rest of the array is skipped. */
export function visibleRange(window: IndexWindow, length: number): Range {
  return {
    from: Math.max(0, Math.floor(window.first)),
    to: Math.min(length - 1, Math.ceil(window.last)),
  };
}

function line(
  ctx: CanvasRenderingContext2D,
  values: Float64Array,
  range: Range,
  window: IndexWindow,
  plot: Plot,
  toY: (value: number) => number,
): void {
  ctx.beginPath();
  let drawing = false;

  for (let index = range.from; index <= range.to; index += 1) {
    const value = values[index];
    if (Number.isNaN(value)) {
      // A gap is a gap: joining across it would draw a line through bars the
      // indicator has nothing to say about.
      drawing = false;
      continue;
    }
    const x = xAt(index, window, plot);
    const y = toY(value);
    if (drawing) ctx.lineTo(x, y);
    else {
      ctx.moveTo(x, y);
      drawing = true;
    }
  }

  ctx.stroke();
}

export type OverlayArgs = {
  series: IndicatorSeries;
  window: IndexWindow;
  plot: Plot;
  band: Band;
  scale: (price: number) => number;
};

/**
 * The overlays that live on the price scale.
 *
 * Drawn before the candles by the caller, so a moving average never hides the
 * bar that produced it.
 */
export function drawOverlays(ctx: CanvasRenderingContext2D, args: OverlayArgs): void {
  const { series, window, plot, band, scale } = args;
  const length =
    series.sma?.length ??
    series.ema?.length ??
    series.vwap?.length ??
    series.bollinger?.basis.length ??
    0;
  if (!length) return;

  const range = visibleRange(window, length);
  if (range.to < range.from) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, band.top, plot.width, band.height);
  ctx.clip();
  ctx.lineWidth = 1.25;

  if (series.bollinger) {
    const { basis, upper, lower } = series.bollinger;

    // The channel is shaded before its edges are drawn, so the fill never sits
    // on top of the lines that bound it.
    ctx.fillStyle = INDICATOR_COLOURS.bollingerFill;
    ctx.beginPath();
    let started = false;
    for (let index = range.from; index <= range.to; index += 1) {
      if (Number.isNaN(upper[index])) continue;
      const x = xAt(index, window, plot);
      if (started) ctx.lineTo(x, scale(upper[index]));
      else {
        ctx.moveTo(x, scale(upper[index]));
        started = true;
      }
    }
    for (let index = range.to; index >= range.from; index -= 1) {
      if (Number.isNaN(lower[index])) continue;
      ctx.lineTo(xAt(index, window, plot), scale(lower[index]));
    }
    if (started) {
      ctx.closePath();
      ctx.fill();
    }

    ctx.strokeStyle = INDICATOR_COLOURS.bollinger;
    line(ctx, upper, range, window, plot, scale);
    line(ctx, lower, range, window, plot, scale);
    ctx.setLineDash([3, 3]);
    line(ctx, basis, range, window, plot, scale);
    ctx.setLineDash([]);
  }

  if (series.sma) {
    ctx.strokeStyle = INDICATOR_COLOURS.sma;
    line(ctx, series.sma, range, window, plot, scale);
  }

  if (series.ema) {
    ctx.strokeStyle = INDICATOR_COLOURS.ema;
    line(ctx, series.ema, range, window, plot, scale);
  }

  if (series.vwap) {
    ctx.strokeStyle = INDICATOR_COLOURS.vwap;
    line(ctx, series.vwap, range, window, plot, scale);
  }

  ctx.restore();
}

export type PaneArgs = {
  id: PaneId;
  band: Band;
  series: IndicatorSeries;
  window: IndexWindow;
  plot: Plot;
  /**
   * Full canvas width, including the axis gutter. The clip has to reach past
   * the plot or it eats the scale labels, which is exactly what it did the
   * first time — the RSI drew its 30 and 70 guides with no numbers beside them.
   */
  canvasWidth: number;
  /**
   * Whether each bar closed up, so volume can be coloured by the candle it
   * belongs to. Volume has no direction of its own — a heavy day says nothing
   * about which way it went — so it borrows the price's.
   */
  rising?: (index: number) => boolean;
};

/** RSI's fixed 0–100 scale, so the guides mean the same thing on every symbol. */
const RSI_LOW = 0;
const RSI_HIGH = 100;
const RSI_GUIDES = [30, 70];

export function drawPane(ctx: CanvasRenderingContext2D, args: PaneArgs): void {
  const { id, band, series, window, plot, canvasWidth } = args;

  ctx.save();
  ctx.beginPath();
  // Clipped vertically to the band, horizontally to the whole canvas: the band
  // is what a pane must not spill out of, the gutter is where its labels live.
  ctx.rect(0, band.top, canvasWidth, band.height);
  ctx.clip();

  // A hairline above each pane, so it reads as its own region rather than as
  // more of the chart above it.
  ctx.strokeStyle = INDICATOR_COLOURS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(band.top) + 0.5);
  ctx.lineTo(plot.width, Math.round(band.top) + 0.5);
  ctx.stroke();

  ctx.font = '10px ui-monospace, monospace';
  ctx.textBaseline = 'middle';

  if (id === 'volume' && series.volume) {
    drawVolume(ctx, series.volume, args.rising, band, window, plot);
  } else if (id === 'rsi' && series.rsi) {
    drawRsi(ctx, series.rsi, band, window, plot);
  } else if (id === 'macd' && series.macd) {
    drawMacd(ctx, series.macd, band, window, plot);
  }

  ctx.restore();
}

function drawRsi(
  ctx: CanvasRenderingContext2D,
  values: Float64Array,
  band: Band,
  window: IndexWindow,
  plot: Plot,
): void {
  const range = visibleRange(window, values.length);
  const toY = (value: number) => valueToY(value, band, RSI_LOW, RSI_HIGH);

  ctx.strokeStyle = INDICATOR_COLOURS.rsiGuide;
  ctx.setLineDash([2, 3]);
  for (const level of RSI_GUIDES) {
    const y = Math.round(toY(level)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(plot.width, y);
    ctx.stroke();

    ctx.fillStyle = INDICATOR_COLOURS.axis;
    ctx.textAlign = 'left';
    ctx.fillText(String(level), plot.width + 6, y);
  }
  ctx.setLineDash([]);

  ctx.strokeStyle = INDICATOR_COLOURS.rsi;
  ctx.lineWidth = 1.25;
  line(ctx, values, range, window, plot, toY);

  label(ctx, `RSI ${RSI_PERIOD}`, band);
}

function drawMacd(
  ctx: CanvasRenderingContext2D,
  parts: { macd: Float64Array; signal: Float64Array; histogram: Float64Array },
  band: Band,
  window: IndexWindow,
  plot: Plot,
): void {
  const range = visibleRange(window, parts.macd.length);
  const [low, high] = extentOf([parts.macd, parts.signal, parts.histogram], range.from, range.to);

  // Forced symmetric about zero: the histogram's sign is the reading, and a
  // scale that put zero anywhere but the middle would make a small negative
  // look like a large one.
  const bound = Math.max(Math.abs(low), Math.abs(high)) || 1;
  const toY = (value: number) => valueToY(value, band, -bound, bound);
  const zero = toY(0);

  const slot = plot.width / Math.max(1, window.last - window.first);
  const barWidth = Math.max(1, slot * 0.6);

  for (let index = range.from; index <= range.to; index += 1) {
    const value = parts.histogram[index];
    if (Number.isNaN(value)) continue;
    const x = xAt(index, window, plot);
    const y = toY(value);
    ctx.fillStyle = value >= 0 ? INDICATOR_COLOURS.up : INDICATOR_COLOURS.down;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x - barWidth / 2, Math.min(y, zero), barWidth, Math.max(1, Math.abs(y - zero)));
  }
  ctx.globalAlpha = 1;

  ctx.strokeStyle = INDICATOR_COLOURS.grid;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(zero) + 0.5);
  ctx.lineTo(plot.width, Math.round(zero) + 0.5);
  ctx.stroke();

  ctx.lineWidth = 1.25;
  ctx.strokeStyle = INDICATOR_COLOURS.macd;
  line(ctx, parts.macd, range, window, plot, toY);
  ctx.strokeStyle = INDICATOR_COLOURS.signal;
  line(ctx, parts.signal, range, window, plot, toY);

  label(ctx, 'MACD 12/26/9', band);
}

function label(ctx: CanvasRenderingContext2D, text: string, band: Band): void {
  ctx.fillStyle = INDICATOR_COLOURS.axis;
  ctx.textAlign = 'left';
  ctx.fillText(text, 6, band.top + 9);
}

/**
 * Volume, as bars from the floor of its band.
 *
 * Scaled to the visible window rather than to the whole series, so a spike in
 * 2024 does not flatten a month in 2026 into nothing. That is the same reason
 * the price autoscales to what is on screen.
 *
 * A zero-volume bar draws nothing at all. Yahoo reports zero for a session that
 * has not traded — the forming bar most often — and a one-pixel stub there
 * would claim trading that did not happen.
 */
function drawVolume(
  ctx: CanvasRenderingContext2D,
  values: Float64Array,
  rising: ((index: number) => boolean) | undefined,
  band: Band,
  window: IndexWindow,
  plot: Plot,
): void {
  const range = visibleRange(window, values.length);

  let peak = 0;
  for (let index = range.from; index <= range.to; index += 1) {
    const value = values[index];
    if (!Number.isNaN(value) && value > peak) peak = value;
  }
  if (peak <= 0) return;

  const slot = plot.width / Math.max(1, window.last - window.first);
  const width = Math.max(1, slot * 0.6);
  const floor = band.top + band.height;

  for (let index = range.from; index <= range.to; index += 1) {
    const value = values[index];
    if (Number.isNaN(value) || value <= 0) continue;

    const height = (value / peak) * band.height;
    ctx.fillStyle =
      rising?.(index) === false ? INDICATOR_COLOURS.volumeDown : INDICATOR_COLOURS.volume;
    ctx.fillRect(xAt(index, window, plot) - width / 2, floor - height, width, height);
  }

  label(ctx, `Volume · peak ${compact(peak)}`, band);
}

/** Volume runs to the hundreds of millions; the axis has room for four characters. */
export function compact(value: number): string {
  const units: [number, string][] = [
    [1e12, 'T'],
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'K'],
  ];
  for (const [size, suffix] of units) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 100 ? Math.round(scaled) : scaled.toFixed(1)}${suffix}`;
    }
  }
  return value >= 10 ? String(Math.round(value)) : value.toFixed(2);
}
