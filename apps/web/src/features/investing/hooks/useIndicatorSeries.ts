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
  macd,
  rsi,
  sma,
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
export function useIndicatorSeries(bars: Bar[], indicators: Indicators): IndicatorSeries {
  const active = indicators.active.join(',');

  return useMemo(() => {
    if (!bars.length) return {};

    const wanted = active ? active.split(',') : [];
    const has = (id: string) => wanted.includes(id);
    // One pass to lift the closes, shared by everything that needs them.
    const closes = closesOf(bars);
    const series: IndicatorSeries = {};

    if (has('volume')) {
      const volume = new Float64Array(bars.length);
      for (let i = 0; i < bars.length; i += 1) volume[i] = bars[i].volume;
      series.volume = volume;
    }
    if (has('sma')) series.sma = sma(closes, SMA_PERIOD);
    if (has('ema')) series.ema = ema(closes, EMA_PERIOD);
    if (has('bollinger')) series.bollinger = bollinger(closes, BOLLINGER_PERIOD);
    if (has('rsi')) series.rsi = rsi(closes);
    if (has('macd')) series.macd = macd(closes);

    return series;
  }, [bars, active]);
}

export { isActive };
