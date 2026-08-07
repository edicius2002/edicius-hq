import { useMemo } from 'react';

import type { IndicatorSeries } from '@/features/investing/chart/indicatorLayers';
import { isActive, type Indicators } from '@/features/investing/data/indicators';
import {
  BOLLINGER_PERIOD,
  EMA_PERIOD,
  SMA_PERIOD,
  bollinger,
  closesOf,
  ema,
  hasIntradaySessions,
  macd,
  rsi,
  sma,
  vwap,
} from '@/features/investing/lib/indicators';
import type { Bar } from '@/shared/api/market';

/**
 * The active indicators, computed once per series rather than per frame.
 *
 * This is the whole performance story. Panning and zooming change the window
 * fifty times a second and change none of these values — they are functions of
 * the bars alone — so they are memoised on the bars and the active set, and the
 * draw walks arrays that are already there. Recomputing an RSI on every pointer
 * move would be a thousand passes a second over data that had not moved.
 *
 * An indicator that is off is not computed at all; the field is simply absent.
 */
export function useIndicatorSeries(
  bars: Bar[],
  indicators: Indicators,
  timeframe: string,
): IndicatorSeries {
  const active = indicators.active.join(',');

  return useMemo(() => {
    if (!bars.length) return {};

    const wanted = active ? active.split(',') : [];
    const has = (id: string) => wanted.includes(id);
    // One pass to lift the closes, shared by everything that needs them.
    const closes = closesOf(bars);
    const series: IndicatorSeries = {};

    if (has('sma')) series.sma = sma(closes, SMA_PERIOD);
    if (has('ema')) series.ema = ema(closes, EMA_PERIOD);
    if (has('bollinger')) series.bollinger = bollinger(closes, BOLLINGER_PERIOD);
    // Session VWAP degenerates to the typical price when every bar is its own
    // session, so it is not offered — or computed — outside intraday.
    if (has('vwap') && hasIntradaySessions(timeframe)) series.vwap = vwap(bars);
    if (has('rsi')) series.rsi = rsi(closes);
    if (has('macd')) series.macd = macd(closes);

    return series;
  }, [bars, active, timeframe]);
}

/** Whether an indicator can say anything on this timeframe. */
export function isOffered(id: string, timeframe: string): boolean {
  return id !== 'vwap' || hasIntradaySessions(timeframe);
}

export { isActive };
