import { useMemo, useState, type PointerEvent } from 'react';

import { useElementWidth } from '@/features/greenlight/hooks/useElementWidth';
import {
  buildWeekAxisTicks,
  formatAxisMoney,
  formatBarMoney,
} from '@/features/greenlight/lib/chartFormat';
import type { WeekPoint } from '@/features/greenlight/model/types';

import styles from './WeeklyChart.module.css';

const FALLBACK_WIDTH = 560;
const MIN_WIDTH = 320;
const CHART_HEIGHT = 300;

type WeeklyChartProps = {
  points: WeekPoint[];
};

/** One bar for every calendar week, including zero-value gaps. */
export function WeeklyChart({ points }: WeeklyChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [wrapRef, measuredWidth] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);

  const layout = useMemo(() => {
    const width = Math.max(measuredWidth, MIN_WIDTH);
    const height = CHART_HEIGHT;
    const pad = { top: 26, right: 26, bottom: 58, left: 60 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxValue = Math.max(...points.map((point) => point.amount), 0);
    const { top, ticks } = buildWeekAxisTicks(maxValue);
    const baseY = pad.top + plotH;
    const groupW = plotW / Math.max(points.length, 1);
    const barW = Math.max(3, Math.min(30, groupW * 0.72));
    const xAt = (index: number) => pad.left + groupW * (index + 0.5);
    const yAt = (value: number) => baseY - (value / top) * plotH;
    const bars = points.map((point, index) => {
      const barH = point.amount > 0 ? Math.max(baseY - yAt(point.amount), 2) : 2;
      return { ...point, x: xAt(index), y: baseY - barH, height: barH };
    });
    // The bars stay complete; only date labels thin out when space is limited.
    const maxLabels = Math.max(2, Math.floor(plotW / 72));
    const labelStep = points.length > maxLabels ? Math.ceil(points.length / maxLabels) : 1;
    return { width, height, pad, ticks, bars, baseY, groupW, barW, labelStep, xAt, yAt };
  }, [points, measuredWidth]);

  if (!points.length) {
    return <p className={styles.empty}>No weeks to chart yet.</p>;
  }

  const { width, height, pad, ticks, bars, baseY, groupW, barW, labelStep, xAt, yAt } = layout;
  const hover = hoverIndex === null ? null : bars[hoverIndex];

  function onMove(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const relX = ((event.clientX - rect.left) / rect.width) * width;
    if (relX < pad.left || relX > width - pad.right) {
      setHoverIndex(null);
      return;
    }
    const idx = Math.max(0, Math.min(bars.length - 1, Math.floor((relX - pad.left) / groupW)));
    setHoverIndex(idx);
  }

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={styles.svg}
        role="img"
        aria-label="Weekly deliverable value"
        onPointerMove={onMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        {ticks.map((tick) => {
          const yPos = yAt(tick);
          return (
            <g key={tick}>
              <line
                className={styles.grid}
                x1={pad.left}
                x2={width - pad.right}
                y1={yPos}
                y2={yPos}
              />
              <text className={styles.axis} x={pad.left - 8} y={yPos + 3} textAnchor="end">
                {formatAxisMoney(tick)}
              </text>
            </g>
          );
        })}
        <line className={styles.axisLine} x1={pad.left} y1={pad.top} x2={pad.left} y2={baseY} />
        <line
          className={styles.axisLine}
          x1={pad.left}
          y1={baseY}
          x2={width - pad.right}
          y2={baseY}
        />
        {bars.map((bar, index) => (
          <g key={bar.key}>
            <title>
              {bar.label}: {formatBarMoney(bar.amount)}
            </title>
            <rect
              className={`${bar.amount > 0 ? styles.bar : styles.emptyBar} ${hoverIndex === index ? styles.barHovered : ''}`}
              x={bar.x - barW / 2}
              y={bar.y}
              width={barW}
              height={bar.height}
              rx={barW > 8 ? 2 : 0}
            />
          </g>
        ))}
        {points.map((point, index) => {
          if (index % labelStep !== 0 && index !== points.length - 1) return null;
          return (
            <text
              key={`${point.key}-label`}
              className={styles.axis}
              x={xAt(index)}
              y={height - 34}
              textAnchor="middle"
            >
              <tspan x={xAt(index)} dy="0">
                {point.startLabel}
              </tspan>
              <tspan className={styles.axisSub} x={xAt(index)} dy="12">
                {point.endLabel}
              </tspan>
            </text>
          );
        })}
      </svg>
      {hover ? (
        <div
          className={styles.tooltip}
          style={{
            left: `${(hover.x / width) * 100}%`,
            top: `${(hover.y / height) * 100}%`,
          }}
        >
          <span className={styles.tipValue}>{formatBarMoney(hover.amount)}</span>
          <span className={styles.tipLabel}>{hover.label}</span>
        </div>
      ) : null}
    </div>
  );
}
