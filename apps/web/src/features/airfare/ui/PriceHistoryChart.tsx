import { useMemo } from 'react';

import { linePath, priceBand, priceTicks, xAt, yAt } from '@/features/airfare/lib/scales';
import type { PricePoint } from '@/features/airfare/lib/series';
import { formatMoney } from '@/shared/lib/money';

import styles from './PriceHistoryChart.module.css';

const VIEWPORT = {
  width: 720,
  height: 260,
  padding: { top: 16, right: 16, bottom: 28, left: 64 },
};

type PriceHistoryChartProps = {
  points: PricePoint[];
  currency: string;
  label: string;
};

/**
 * The cheapest fare over time, as SVG.
 *
 * SVG rather than the canvas Investing uses. That chart earns its canvas with
 * pan, zoom and thousands of candles; this one draws a handful of points a
 * month, and in the DOM every one of them is a node a test can find and a
 * screen reader can reach. `viewBox` with no fixed width does the responsive
 * part for free.
 */
export function PriceHistoryChart({ points, currency, label }: PriceHistoryChartProps) {
  const band = useMemo(() => priceBand(points), [points]);
  const ticks = useMemo(() => priceTicks(band), [band]);
  const path = useMemo(() => linePath(points, band, VIEWPORT), [points, band]);

  if (points.length === 0) {
    return (
      <p className={styles.empty}>
        No observations yet. Run a collection pass and the first point lands here.
      </p>
    );
  }

  const summary = points
    .map((point) => `${point.capturedAt.slice(0, 10)}: ${formatMoney(point.price, currency)}`)
    .join('; ');

  return (
    <figure className={styles.figure}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${VIEWPORT.width} ${VIEWPORT.height}`}
        role="img"
        aria-label={`${label}. ${summary}`}
      >
        {ticks.map((tick) => {
          const y = yAt(tick, band, VIEWPORT);
          return (
            <g key={tick}>
              <line
                className={styles.gridLine}
                x1={VIEWPORT.padding.left}
                x2={VIEWPORT.width - VIEWPORT.padding.right}
                y1={y}
                y2={y}
              />
              <text className={styles.axisLabel} x={VIEWPORT.padding.left - 8} y={y + 4}>
                {formatMoney(tick, currency)}
              </text>
            </g>
          );
        })}

        <path className={styles.line} d={path} />

        {points.map((point, index) => (
          <circle
            key={point.capturedAt}
            className={styles.point}
            cx={xAt(index, points.length, VIEWPORT)}
            cy={yAt(point.price, band, VIEWPORT)}
            r={3.5}
          >
            <title>
              {point.capturedAt.slice(0, 10)} — {formatMoney(point.price, currency)}
            </title>
          </circle>
        ))}
      </svg>
      {/*
        The dates under the chart are the first and last observation only. With
        a point a day the axis would otherwise be a wall of overlapping labels,
        and every point already carries its own date in a `<title>`.
      */}
      <figcaption className={styles.caption}>
        <span>{points[0].capturedAt.slice(0, 10)}</span>
        <span>
          {points.length} observation{points.length === 1 ? '' : 's'}
        </span>
        <span>{points[points.length - 1].capturedAt.slice(0, 10)}</span>
      </figcaption>
    </figure>
  );
}
