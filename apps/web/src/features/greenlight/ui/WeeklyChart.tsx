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
    const xAt = (index: number) =>
      pad.left + (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
    const yAt = (value: number) => pad.top + plotH - (value / top) * plotH;
    const coords = points.map((point, index) => ({
      ...point,
      x: xAt(index),
      y: yAt(point.amount),
    }));
    const path = coords
      .map((c, index) => `${index === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
      .join(' ');
    const baseY = pad.top + plotH;
    const area = `${coords.map((c) => `${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(' ')} ${coords.at(-1)?.x.toFixed(1)},${baseY} ${coords[0]?.x.toFixed(1)},${baseY}`;
    // Keep x labels from colliding: allow roughly one label per 72px of plot width.
    const maxLabels = Math.max(2, Math.floor(plotW / 72));
    const labelStep = points.length > maxLabels ? Math.ceil(points.length / maxLabels) : 1;
    return { width, height, pad, top, ticks, coords, path, area, baseY, labelStep, xAt, yAt };
  }, [points, measuredWidth]);

  if (!points.length) {
    return <p className={styles.empty}>No weeks to chart yet.</p>;
  }

  const { width, height, pad, ticks, coords, path, area, baseY, labelStep, xAt, yAt } = layout;
  const hover = hoverIndex === null ? null : coords[hoverIndex];

  function onMove(event: PointerEvent<SVGSVGElement>) {
    const svg = event.currentTarget;
    const rect = svg.getBoundingClientRect();
    const relX = ((event.clientX - rect.left) / rect.width) * width;
    if (relX < pad.left || relX > width - pad.right) {
      setHoverIndex(null);
      return;
    }
    const ratio = (relX - pad.left) / (width - pad.left - pad.right);
    const idx = Math.max(0, Math.min(coords.length - 1, Math.round(ratio * (coords.length - 1))));
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
        <polygon className={styles.area} points={area} />
        <path className={styles.line} d={path} pathLength={1} />
        {coords.at(-1) ? (
          <circle className={styles.dot} cx={coords.at(-1)!.x} cy={coords.at(-1)!.y} r={3.5} />
        ) : null}
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
        {hover ? (
          <g className={styles.hover}>
            <line className={styles.crosshair} x1={hover.x} x2={hover.x} y1={pad.top} y2={baseY} />
            <circle className={styles.cursor} cx={hover.x} cy={hover.y} r={5} />
          </g>
        ) : null}
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
