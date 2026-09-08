import type { SentimentMetric } from '@/shared/api/sentiment';

export const SENTIMENT_VIEW = { width: 720, height: 280 } as const;
export const SENTIMENT_PLOT = { left: 68, right: 702, top: 18, bottom: 238 } as const;

export type ChartPoint = {
  timestamp: string;
  value: number;
  x: number;
  y: number;
};

export type ChartLayout = {
  domain: { min: number; max: number };
  time: { min: number; max: number };
  plot: typeof SENTIMENT_PLOT;
  paths: { key: string; d: string; points: ChartPoint[] }[];
  ticks: number[];
  xAt: (timestamp: string) => number;
  yAt: (value: number) => number;
};

export function chartLayout(metric: SentimentMetric): ChartLayout {
  const points = metric.series.flatMap((series) => series.points);
  const values = points.map((point) => point.value).filter(Number.isFinite);
  const times = points.map((point) => Date.parse(point.timestamp)).filter(Number.isFinite);
  const rawMin = values.length ? Math.min(...values) : 0;
  const rawMax = values.length ? Math.max(...values) : 1;
  const padding = rawMin === rawMax ? Math.max(Math.abs(rawMin) * 0.05, 1) : 0;
  const domain = { min: rawMin - padding, max: rawMax + padding };
  const time = {
    min: times.length ? Math.min(...times) : 0,
    max: times.length ? Math.max(...times) : 1,
  };
  if (time.min === time.max) time.max += 24 * 60 * 60 * 1000;

  const xAt = (timestamp: string) => {
    const at = Date.parse(timestamp);
    const ratio = (at - time.min) / (time.max - time.min);
    return SENTIMENT_PLOT.left + ratio * (SENTIMENT_PLOT.right - SENTIMENT_PLOT.left);
  };
  const yAt = (value: number) => {
    const ratio = (value - domain.min) / (domain.max - domain.min);
    return SENTIMENT_PLOT.bottom - ratio * (SENTIMENT_PLOT.bottom - SENTIMENT_PLOT.top);
  };
  const paths = metric.series.map((series) => {
    const placed = series.points.map((point) => ({
      timestamp: point.timestamp,
      value: point.value,
      x: xAt(point.timestamp),
      y: yAt(point.value),
    }));
    return {
      key: series.key,
      points: placed,
      d: placed
        .map(
          (point, index) =>
            `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.y.toFixed(2)}`,
        )
        .join(' '),
    };
  });
  const ticks = Array.from({ length: 4 }, (_, index) => {
    return domain.min + ((domain.max - domain.min) * index) / 3;
  });
  return { domain, time, plot: SENTIMENT_PLOT, paths, ticks, xAt, yAt };
}

const NUMBER = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

export function formatSeriesValue(value: number, unit: string): string {
  return `${NUMBER.format(value)} ${unit}`;
}

export function formatChartDate(timestamp: string): string {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(timestamp));
}
