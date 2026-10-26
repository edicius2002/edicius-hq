import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import {
  SENTIMENT_PLOT,
  SENTIMENT_VIEW,
  chartLayout,
  formatChartDate,
  formatChartValue,
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
  const keyboardStatusId = useId();
  const [isActive, setIsActive] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
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
  const selectedDate = formatChartDate(selected.timestamp);
  const selectedValue = formatChartValue(selected.value);
  const dateTagWidth = 92;
  const dateTagX = Math.min(
    Math.max(selectedX - dateTagWidth / 2, 2),
    SENTIMENT_VIEW.width - dateTagWidth - 2,
  );
  const valueTagWidth = Math.max(44, selectedValue.length * 6 + 12);
  const valueTagX = Math.max(2, SENTIMENT_PLOT.left - valueTagWidth - 4);
  const valueTagY = Math.min(
    Math.max(selectedY - 9, SENTIMENT_PLOT.top),
    SENTIMENT_PLOT.bottom - 18,
  );
  const referencePoints = metric.series.slice(1).flatMap((series) => {
    const point = pointAt(series, selected.timestamp);
    return point ? [{ key: series.key, value: point.value, y: layout.yAt(point.value) }] : [];
  });
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
    setIsActive(true);
    setKeyboardActive(false);
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
    setKeyboardActive(true);
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
          aria-describedby={`${statusId} ${keyboardStatusId}`}
          tabIndex={0}
          onPointerEnter={trackPointer}
          onPointerMove={trackPointer}
          onPointerLeave={() => setIsActive(false)}
          onPointerCancel={() => setIsActive(false)}
          onKeyDown={walk}
          onBlur={() => setKeyboardActive(false)}
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
          {xTicks
            .filter((point) => !isActive || point.timestamp !== selected.timestamp)
            .map((point) => (
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

          {isActive ? (
            <g className={styles.reading} aria-hidden="true">
              <g
                className={styles.crosshair}
                data-testid="sentiment-crosshair"
                style={{ transform: `translate(${selectedX}px, ${selectedY}px)` }}
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
              <g
                className={styles.axisReadingY}
                style={{ transform: `translateY(${selectedY}px)` }}
              >
                <rect
                  className={styles.axisTag}
                  x={valueTagX}
                  y={valueTagY - selectedY}
                  width={valueTagWidth}
                  height={18}
                  rx={3}
                />
                <text
                  className={styles.axisTagText}
                  data-testid="sentiment-y-reading"
                  x={valueTagX + valueTagWidth / 2}
                  y={valueTagY - selectedY + 12.5}
                  textAnchor="middle"
                >
                  {selectedValue}
                </text>
              </g>
              <g
                className={styles.axisReadingX}
                style={{ transform: `translateX(${selectedX}px)` }}
              >
                <rect
                  className={styles.axisTag}
                  x={dateTagX - selectedX}
                  y={SENTIMENT_PLOT.bottom + 5}
                  width={dateTagWidth}
                  height={18}
                  rx={3}
                />
                <text
                  className={styles.axisTagText}
                  data-testid="sentiment-x-reading"
                  x={dateTagX - selectedX + dateTagWidth / 2}
                  y={SENTIMENT_PLOT.bottom + 17.5}
                  textAnchor="middle"
                >
                  {selectedDate}
                </text>
              </g>
              {referencePoints.map((point) => {
                const value = formatChartValue(point.value);
                const width = Math.max(44, value.length * 6 + 12);
                const x =
                  selectedX + 10 + width < SENTIMENT_PLOT.right
                    ? selectedX + 10
                    : selectedX - width - 10;
                const y = Math.min(
                  Math.max(point.y - 9, SENTIMENT_PLOT.top),
                  SENTIMENT_PLOT.bottom - 18,
                );
                return (
                  <g
                    key={point.key}
                    className={styles.referenceReading}
                    style={{ transform: `translate(${selectedX}px, ${point.y}px)` }}
                  >
                    <circle className={styles.referenceMarker} r={3} />
                    <rect
                      className={styles.referenceTag}
                      x={x - selectedX}
                      y={y - point.y}
                      width={width}
                      height={18}
                      rx={3}
                    />
                    <text
                      className={styles.referenceTagText}
                      data-testid={`sentiment-y-reading-${point.key}`}
                      x={x - selectedX + width / 2}
                      y={y - point.y + 12.5}
                      textAnchor="middle"
                    >
                      {value}
                    </text>
                  </g>
                );
              })}
            </g>
          ) : null}
        </svg>

        <p id={statusId} className={styles.srOnly} role="status" aria-live="polite">
          {isActive ? reading(metric, selected) : null}
        </p>
        <span
          id={keyboardStatusId}
          className={styles.srOnly}
          data-testid="sentiment-keyboard-reading"
          aria-live="polite"
        >
          {keyboardActive ? reading(metric, selected) : null}
        </span>
      </div>
    </figure>
  );
}
