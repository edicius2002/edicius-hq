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
const MIN_WEEK_WIDTH = 72;
const CHART_HEIGHT = 300;

type WeeklyChartProps = {
  points: WeekPoint[];
};

/** One bar for every calendar week, including zero-value gaps. */
export function WeeklyChart({ points }: WeeklyChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [wrapRef, measuredWidth] = useElementWidth<HTMLDivElement>(FALLBACK_WIDTH);

  const layout = useMemo(() => {
    const pad = { top: 26, right: 26, bottom: 58, left: 60 };
    const width = Math.max(
      measuredWidth,
      MIN_WIDTH - pad.left,
      points.length * MIN_WEEK_WIDTH + pad.right,
    );
    const height = CHART_HEIGHT;
    const plotW = width - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const maxValue = Math.max(...points.map((point) => point.amount), 0);
    const { top, ticks } = buildWeekAxisTicks(maxValue);
    const baseY = pad.top + plotH;
    const groupW = plotW / Math.max(points.length, 1);
    const barW = groupW;
    const xAt = (index: number) => groupW * (index + 0.5);
    const yAt = (value: number) => baseY - (value / top) * plotH;
    const bars = points.map((point, index) => {
      const barH = point.amount > 0 ? Math.max(baseY - yAt(point.amount), 2) : 2;
      return { ...point, x: groupW * index, y: baseY - barH, height: barH };
    });
    return { width, height, pad, ticks, bars, baseY, groupW, barW, xAt, yAt };
  }, [points, measuredWidth]);

  if (!points.length) {
    return <p className={styles.empty}>No weeks to chart yet.</p>;
  }

  const { width, height, pad, ticks, bars, baseY, groupW, barW, xAt, yAt } = layout;
  const hover = hoverIndex === null ? null : bars[hoverIndex];

  function onMove(event: PointerEvent<SVGSVGElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const relX = ((event.clientX - rect.left) / rect.width) * width;
    if (relX < 0 || relX > width - pad.right) {
      setHoverIndex(null);
      return;
    }
    const idx = Math.max(0, Math.min(bars.length - 1, Math.floor(relX / groupW)));
    setHoverIndex(idx);
  }

  return (
    <div className={styles.wrap}>
      <svg viewBox={`0 0 ${pad.left} ${height}`} className={styles.yAxis} aria-hidden="true">
        {ticks.map((tick) => {
          const yPos = yAt(tick);
          return (
            <text key={tick} className={styles.axis} x={pad.left - 8} y={yPos + 3} textAnchor="end">
              {formatAxisMoney(tick)}
            </text>
          );
        })}
        <line
          className={styles.axisLine}
          x1={pad.left - 1}
          y1={pad.top}
          x2={pad.left - 1}
          y2={baseY}
        />
      </svg>
      <div
        className={styles.scroller}
        ref={wrapRef}
        tabIndex={0}
        role="region"
        aria-label="Weekly histogram; scroll horizontally to view all weeks"
      >
        <div className={styles.canvas} style={{ width }}>
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
                  <line className={styles.grid} x1={0} x2={width - pad.right} y1={yPos} y2={yPos} />
                </g>
              );
            })}
            <line className={styles.axisLine} x1={0} y1={baseY} x2={width - pad.right} y2={baseY} />
            {bars.map((bar, index) => (
              <g key={bar.key}>
                <title>
                  {bar.label}: {formatBarMoney(bar.amount)}
                </title>
                <rect
                  className={`${bar.amount > 0 ? styles.bar : styles.emptyBar} ${hoverIndex === index ? styles.barHovered : ''}`}
                  x={bar.x}
                  y={bar.y}
                  width={barW}
                  height={bar.height}
                  rx={0}
                />
              </g>
            ))}
            {points.map((point, index) => {
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
                    → {point.endLabel}
                  </tspan>
                </text>
              );
            })}
          </svg>
          {hover ? (
            <div
              className={styles.tooltip}
              style={{
                left: `${Math.max(90, Math.min(width - 90, hover.x + barW / 2))}px`,
                top: `${Math.max(70, hover.y)}px`,
              }}
            >
              <span className={styles.tipValue}>{formatBarMoney(hover.amount)}</span>
              <span className={styles.tipLabel}>{hover.label}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
