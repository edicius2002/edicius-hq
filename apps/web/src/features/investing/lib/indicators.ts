/**
 * The indicator maths, as pure functions over the bars the chart already holds.
 *
 * Two adaptations from the legacy, both about speed rather than taste.
 *
 * **Index-aligned typed arrays, not `[{time, value}]`.** The legacy carried
 * points keyed by time and then looked them up with a binary search on every
 * crosshair move — `seriesPointAtTime` and `candleCloseAtTime` are both O(log n)
 * per read, and every read allocated. Our x axis is already the bar index
 * (decision 8.10), so a `Float64Array` indexed the same way makes the same read
 * a single array access and allocates once per series instead of once per bar.
 *
 * **`NaN` means "not yet", not a missing entry.** An RSI cannot speak until it
 * has 15 bars and a MACD signal until 35. Holding that as `NaN` in a
 * full-length array keeps every series the same length as the bars, so nothing
 * downstream has to reason about offsets — and the rule that no value is ever
 * invented is enforced by the shape rather than by remembering to check.
 *
 * Everything here is a single pass. Nothing recomputes a window it has already
 * summed.
 */

import type { Bar } from '@/shared/api/market';

/** The industry defaults, and the ones the legacy read. Not settings — see #45. */
export const RSI_PERIOD = 14;
export const MACD_FAST = 12;
export const MACD_SLOW = 26;
export const MACD_SIGNAL = 9;
export const BOLLINGER_PERIOD = 20;
export const BOLLINGER_DEVIATIONS = 2;
export const SMA_PERIOD = 20;
export const EMA_PERIOD = 20;

function filled(length: number): Float64Array {
  const out = new Float64Array(length);
  out.fill(Number.NaN);
  return out;
}

export function closesOf(bars: Bar[]): Float64Array {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i += 1) out[i] = bars[i].close;
  return out;
}

/** Simple moving average, by rolling sum rather than by re-adding the window. */
export function sma(values: Float64Array, period: number): Float64Array {
  const out = filled(values.length);
  if (period < 1 || values.length < period) return out;

  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * Exponential moving average, seeded with the simple average of the first
 * window.
 *
 * Seeding from a simple average rather than from the first value is what every
 * charting package does, and it matters: seeding from one bar lets a single
 * opening print drag the line for dozens of periods afterwards.
 */
export function ema(values: Float64Array, period: number): Float64Array {
  const out = filled(values.length);
  if (period < 1 || values.length < period) return out;

  const weight = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];

  let previous = sum / period;
  out[period - 1] = previous;

  for (let i = period; i < values.length; i += 1) {
    previous = (values[i] - previous) * weight + previous;
    out[i] = previous;
  }
  return out;
}

export type Bands = {
  basis: Float64Array;
  upper: Float64Array;
  lower: Float64Array;
};

/**
 * Bollinger Bands: a simple average with a standard deviation either side.
 *
 * The deviation comes from rolling sums of the values and of their squares, so
 * the whole thing stays one pass. That identity can produce a very slightly
 * negative variance from floating-point rounding when a window is nearly flat,
 * which is what the clamp is for — a real variance is never negative.
 */
export function bollinger(
  values: Float64Array,
  period = BOLLINGER_PERIOD,
  deviations = BOLLINGER_DEVIATIONS,
): Bands {
  const basis = filled(values.length);
  const upper = filled(values.length);
  const lower = filled(values.length);
  if (period < 1 || values.length < period) return { basis, upper, lower };

  let sum = 0;
  let squares = 0;

  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    sum += value;
    squares += value * value;

    if (i >= period) {
      const gone = values[i - period];
      sum -= gone;
      squares -= gone * gone;
    }

    if (i >= period - 1) {
      const mean = sum / period;
      const variance = Math.max(0, squares / period - mean * mean);
      const spread = Math.sqrt(variance) * deviations;
      basis[i] = mean;
      upper[i] = mean + spread;
      lower[i] = mean - spread;
    }
  }

  return { basis, upper, lower };
}

/**
 * Session VWAP: cumulative typical price weighted by volume, reset each day.
 *
 * Reset is the whole point — a VWAP that ran across sessions would be an
 * average of a week, which is not what anyone means by it. Bars are already in
 * order, so the day boundary is a comparison rather than a lookup.
 *
 * Only meaningful intraday; `hasIntradaySessions` is what decides whether to
 * offer it at all.
 */
export function vwap(bars: Bar[]): Float64Array {
  const out = filled(bars.length);
  let cumulativePV = 0;
  let cumulativeVolume = 0;
  let day = Number.NaN;

  for (let i = 0; i < bars.length; i += 1) {
    const bar = bars[i];
    const barDay = Math.floor(bar.time / 86_400);
    if (barDay !== day) {
      cumulativePV = 0;
      cumulativeVolume = 0;
      day = barDay;
    }

    const typical = (bar.high + bar.low + bar.close) / 3;
    const volume = bar.volume || 0;
    cumulativePV += typical * volume;
    cumulativeVolume += volume;

    // A session with no reported volume has no volume-weighted price. The
    // typical price is what it degenerates to, and is honest about it.
    out[i] = cumulativeVolume > 0 ? cumulativePV / cumulativeVolume : typical;
  }

  return out;
}

/** One bar per session or longer means every bar is its own session. */
const INTRADAY = new Set(['1m', '5m', '15m', '1h']);

export function hasIntradaySessions(timeframe: string): boolean {
  return INTRADAY.has(timeframe);
}

/**
 * Relative strength, with Wilder's smoothing after a simple first average.
 *
 * The first average is a plain mean of the opening window rather than a
 * recursive one — the legacy did the same, and its own comment notes the two
 * diverge slightly over the first bars and converge within a handful of
 * periods. Matched deliberately, so the old chart and this one agree on the
 * same data rather than differing by an amount nobody could explain.
 */
export function rsi(values: Float64Array, period = RSI_PERIOD): Float64Array {
  const out = filled(values.length);
  if (values.length < period + 1) return out;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) gains += change;
    else losses -= change;
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;
  out[period] = strength(averageGain, averageLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;

    averageGain = (averageGain * (period - 1) + gain) / period;
    averageLoss = (averageLoss * (period - 1) + loss) / period;
    out[i] = strength(averageGain, averageLoss);
  }

  return out;
}

function strength(averageGain: number, averageLoss: number): number {
  // Nothing but gains has no ratio to take; the limit is 100, and saying so
  // beats dividing by zero and drawing a gap in a run that never fell.
  if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

export type Macd = {
  macd: Float64Array;
  signal: Float64Array;
  histogram: Float64Array;
};

/**
 * MACD: the gap between two exponential averages, and the average of that gap.
 *
 * The signal line is an EMA of the MACD line, which only exists from the slow
 * period onwards — so it is computed over the defined stretch and written back
 * at the right offset rather than over an array that starts with `NaN`.
 */
export function macd(
  values: Float64Array,
  fast = MACD_FAST,
  slow = MACD_SLOW,
  signalPeriod = MACD_SIGNAL,
): Macd {
  const line = filled(values.length);
  const signal = filled(values.length);
  const histogram = filled(values.length);
  if (values.length < slow) return { macd: line, signal, histogram };

  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);

  const start = slow - 1;
  const defined = new Float64Array(values.length - start);
  for (let i = start; i < values.length; i += 1) {
    const value = fastEma[i] - slowEma[i];
    line[i] = value;
    defined[i - start] = value;
  }

  const signalOfDefined = ema(defined, signalPeriod);
  for (let i = 0; i < signalOfDefined.length; i += 1) {
    const value = signalOfDefined[i];
    if (Number.isNaN(value)) continue;
    const index = i + start;
    signal[index] = value;
    histogram[index] = line[index] - value;
  }

  return { macd: line, signal, histogram };
}

/** The smallest and largest defined value, for scaling a pane. */
export function extentOf(series: Float64Array[], from: number, to: number): [number, number] {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;

  for (const values of series) {
    const start = Math.max(0, from);
    const end = Math.min(values.length, to + 1);
    for (let i = start; i < end; i += 1) {
      const value = values[i];
      if (Number.isNaN(value)) continue;
      if (value < low) low = value;
      if (value > high) high = value;
    }
  }

  return low <= high ? [low, high] : [0, 1];
}
