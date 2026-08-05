import { useMemo } from 'react';

import { useElementWidth } from '@/features/greenlight/hooks/useElementWidth';
import {
  buildAxisTicks,
  formatAxisMoney,
  formatBarMoney,
} from '@/features/greenlight/lib/chartFormat';
import type { MonthPoint } from '@/features/greenlight/model/types';

import styles from './MonthlyChart.module.css';

const FALLBACK_WIDTH = 420;
const MIN_WIDTH = 280;
const CHART_HEIGHT = 300;

type MonthlyChartProps = {
  points: MonthPoint[];
};

export function MonthlyChart({ points }: MonthlyChartProps) {
  const [wrapRef, measuredWidth] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);

  const layout = useMemo(() => {
    const width = Math.max(measuredWidth, MIN_WIDTH);
    const height = CHART_HEIGHT;
    const pad = { top: 40, right: 26, bottom: 44, left: 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxValue = Math.max(...points.map((p) => p.amount), 0);
    const { top, ticks } = buildAxisTicks(maxValue);
    const groupW = plotW / Math.max(points.length, 1);
    const barW = Math.max(20, Math.min(88, groupW * 0.55));
    const yAt = (value: number) => pad.top + plotH - (value / top) * plotH;
    return { width, height, pad, plotH, top, ticks, groupW, barW, yAt };
  }, [points, measuredWidth]);

  if (!points.length) {
    return <p className={styles.empty}>No months to chart yet.</p>;
  }

  const { width, height, pad, plotH, top, ticks, groupW, barW, yAt } = layout;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={styles.svg}
        role="img"
        aria-label="Monthly deliverable value"
      >
        {ticks.map((tick) => {
          const y = yAt(tick);
          return (
            <g key={tick}>
              <line className={styles.grid} x1={pad.left} x2={width - pad.right} y1={y} y2={y} />
              <text className={styles.axis} x={pad.left - 8} y={y + 3} textAnchor="end">
                {formatAxisMoney(tick)}
              </text>
            </g>
          );
        })}
        <line
          className={styles.axisLine}
          x1={pad.left}
          y1={pad.top}
          x2={pad.left}
          y2={pad.top + plotH}
        />
        <line
          className={styles.axisLine}
          x1={pad.left}
          y1={pad.top + plotH}
          x2={width - pad.right}
          y2={pad.top + plotH}
        />
        {points.map((point, index) => {
          const cx = pad.left + groupW * index + groupW / 2;
          const barH = Math.max((point.amount / top) * plotH, point.amount > 0 ? 2 : 0);
          const barY = pad.top + plotH - barH;
          const parts = String(point.label || '')
            .trim()
            .split(/\s+/);
          const monthTop = parts[0] || point.label;
          const monthBottom = parts.slice(1).join(' ') || '';
          return (
            <g key={point.key}>
              <title>
                {point.label}: {formatBarMoney(point.amount)}
              </title>
              <rect
                className={styles.bar}
                x={cx - barW / 2}
                y={barY}
                width={barW}
                height={barH}
                rx={4}
              />
              <text className={styles.value} x={cx} y={barY - 8} textAnchor="middle">
                {formatBarMoney(point.amount)}
              </text>
              <text className={styles.axis} x={cx} y={height - 28} textAnchor="middle">
                <tspan x={cx} dy="0">
                  {monthTop}
                </tspan>
                <tspan className={styles.axisSub} x={cx} dy="12">
                  {monthBottom}
                </tspan>
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
