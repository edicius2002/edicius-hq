import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import {
  SENTIMENT_PLOT,
  SENTIMENT_VIEW,
  chartLayout,
  formatChartDate,
  formatSeriesValue,
} from '@/features/sentiment/lib/chart';
import { nearestPointIndex, pointerInView } from '@/shared/lib/chartCrosshair';
import type { SentimentMetric, SentimentPoint } from '@/shared/api/sentiment';

import styles from './SentimentChart.module.css';

type SentimentChartProps = {
  metric: SentimentMetric;
};

function pointAt(series: SentimentMetric['series'][number], timestamp: string) {
  return series.points.find((point) => point.timestamp === timestamp);
}

function reading(metric: SentimentMetric, point: SentimentPoint): string {
  const values = metric.series
    .map((series) => {
      const found = pointAt(series, point.timestamp);
      return found ? `${series.label}: ${formatSeriesValue(found.value, series.unit)}` : null;
    })
    .filter(Boolean)
    .join('. ');
  return `${formatChartDate(point.timestamp)}. ${values}.`;
}

export function SentimentChart({ metric }: SentimentChartProps) {
  const statusId = useId();
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, metric.series[0]?.points.length - 1),
  );
  const layout = useMemo(() => chartLayout(metric), [metric]);
  const timeline = metric.series[0]?.points ?? [];

  if (!timeline.length) {
    return <p className={styles.empty}>No historical observations are available.</p>;
  }

  const selected = timeline[Math.min(selectedIndex, timeline.length - 1)];
  const selectedX = layout.xAt(selected.timestamp);
  const selectedY = layout.yAt(selected.value);
  const xTicks = [
    timeline[0],
    timeline[Math.floor((timeline.length - 1) / 2)],
    timeline.at(-1)!,
  ].filter(
    (point, index, all) =>
      all.findIndex((candidate) => candidate.timestamp === point.timestamp) === index,
  );

  function trackPointer(event: PointerEvent<SVGSVGElement>) {
    const at = pointerInView(
      event.currentTarget.getBoundingClientRect(),
      SENTIMENT_VIEW,
      event.clientX,
      event.clientY,
    );
    if (!at) return;
    const ratio = Math.min(
      1,
      Math.max(0, (at.x - SENTIMENT_PLOT.left) / (SENTIMENT_PLOT.right - SENTIMENT_PLOT.left)),
    );
    const timestamp = new Date(
      layout.time.min + ratio * (layout.time.max - layout.time.min),
    ).toISOString();
    const next = nearestPointIndex(timeline, timestamp);
    if (next !== null) setSelectedIndex(next);
  }

  function walk(event: KeyboardEvent<SVGSVGElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return setSelectedIndex(0);
    if (event.key === 'End') return setSelectedIndex(timeline.length - 1);
    const delta = event.key === 'ArrowLeft' ? -1 : 1;
    setSelectedIndex((current) => Math.min(Math.max(current + delta, 0), timeline.length - 1));
  }

  return (
    <figure className={styles.figure}>
      <ul className={styles.legend} aria-label={`${metric.label} legend`}>
        {metric.series.map((series, index) => (
          <li key={series.key}>
            <span className={index === 0 ? styles.legendPrimary : styles.legendReference} />
            {series.label}
          </li>
        ))}
      </ul>

      <div className={styles.plotWrap}>
        <svg
          className={styles.chart}
          viewBox={`0 0 ${SENTIMENT_VIEW.width} ${SENTIMENT_VIEW.height}`}
          role="img"
          aria-label={`${metric.label} history`}
          aria-describedby={statusId}
          tabIndex={0}
          onPointerMove={trackPointer}
          onKeyDown={walk}
        >
          <title>{metric.label} historical chart</title>
          {layout.ticks.map((tick) => {
            const y = layout.yAt(tick);
            return (
              <g key={tick}>
                <line
                  className={styles.grid}
                  x1={SENTIMENT_PLOT.left}
                  x2={SENTIMENT_PLOT.right}
                  y1={y}
                  y2={y}
                />
                <text
                  className={styles.axis}
                  x={SENTIMENT_PLOT.left - 8}
                  y={y + 4}
                  textAnchor="end"
                >
                  {tick.toFixed(2)}
                </text>
              </g>
            );
          })}
          {xTicks.map((point) => (
            <text
              key={point.timestamp}
              className={styles.axis}
              x={layout.xAt(point.timestamp)}
              y={SENTIMENT_VIEW.height - 18}
              textAnchor="middle"
            >
              {formatChartDate(point.timestamp)}
            </text>
          ))}
          <text
            className={styles.axisTitle}
            x={(SENTIMENT_PLOT.left + SENTIMENT_PLOT.right) / 2}
            y={SENTIMENT_VIEW.height - 2}
            textAnchor="middle"
          >
            Date
          </text>
          <text
            className={styles.axisTitle}
            x={12}
            y={(SENTIMENT_PLOT.top + SENTIMENT_PLOT.bottom) / 2}
            textAnchor="middle"
            transform={`rotate(-90 12 ${(SENTIMENT_PLOT.top + SENTIMENT_PLOT.bottom) / 2})`}
          >
            {metric.series[0].unit}
          </text>

          {layout.paths.map((path, index) => (
            <path
              key={path.key}
              data-series={path.key}
              className={index === 0 ? styles.linePrimary : styles.lineReference}
              d={path.d}
            />
          ))}

          <g
            className={styles.crosshair}
            data-testid="sentiment-crosshair"
            style={{ transform: `translate(${selectedX}px, ${selectedY}px)` }}
            aria-hidden="true"
          >
            <line
              className={styles.hair}
              x1={SENTIMENT_PLOT.left - selectedX}
              x2={SENTIMENT_PLOT.right - selectedX}
              y1={0}
              y2={0}
            />
            <line
              className={styles.hair}
              x1={0}
              x2={0}
              y1={SENTIMENT_PLOT.top - selectedY}
              y2={SENTIMENT_PLOT.bottom - selectedY}
            />
            <circle className={styles.marker} r={4} />
          </g>
        </svg>

        <p id={statusId} className={styles.tooltip} role="status" aria-live="polite">
          {reading(metric, selected)}
        </p>
      </div>
    </figure>
  );
}
