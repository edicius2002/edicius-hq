import { useState } from 'react';
import { useElementSize } from '@/shared/lib/useElementSize';
import type { History } from './types';
import { price, time } from './model';
import styles from './FxChart.module.css';
export function FxChart({ history, sourceName }: { history: History; sourceName: string }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [hoverActive, setHoverActive] = useState(false);
  const [keyboardActive, setKeyboardActive] = useState(false);
  const active = hoverActive || keyboardActive;
  const [container, size] = useElementSize<HTMLDivElement>();
  const width = size.width || 320;
  const height = size.height || 160;
  const plotLeft = 64;
  const plotRight = width - 12;
  const plotTop = 12;
  const plotBottom = height - 38;
  const plotWidth = Math.max(1, plotRight - plotLeft);
  const points = history.points;
  if (!points.length)
    return (
      <div className={styles.chart} role="region" aria-label={`${sourceName} USD/PEN history`}>
        <div className={styles.empty}>No history for this range.</div>
      </div>
    );
  const index = Math.min(selected ?? points.length - 1, points.length - 1),
    point = points[index];
  const first = Date.parse(points[0].effective_at),
    last = Date.parse(points.at(-1)!.effective_at);
  const values = points.flatMap((p) => [p.buy, p.sell]),
    lo = Math.min(...values) - 0.002,
    hi = Math.max(...values) + 0.002;
  const yDivisions = 5;
  const yTicks = Array.from(
    { length: yDivisions + 1 },
    (_, index) => lo + ((hi - lo) * index) / yDivisions,
  );
  const x = (p: typeof point) =>
    plotLeft +
    (last === first ? 0.5 : (Date.parse(p.effective_at) - first) / (last - first)) * plotWidth;
  const tickX = (timestamp: number) =>
    plotLeft + (last === first ? 0.5 : (timestamp - first) / (last - first)) * plotWidth;
  const y = (n: number) => plotBottom - ((n - lo) / (hi - lo)) * (plotBottom - plotTop);
  const intraday = history.aggregation === 'observations' && last - first < 86400_000;
  const xTicks = [...new Set([first, first + (last - first) / 2, last])];
  const limaDay = (timestamp: number) =>
    new Date(timestamp).toLocaleDateString('en-US', {
      timeZone: 'America/Lima',
      month: 'short',
      day: 'numeric',
    });
  const crossesLimaDay = limaDay(first) !== limaDay(last);
  const tickLabel = (timestamp: number, index: number) => {
    if (intraday) {
      const hour = new Date(timestamp).toLocaleTimeString('en-US', {
        timeZone: 'America/Lima',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      return crossesLimaDay && (index === 0 || index === xTicks.length - 1)
        ? `${limaDay(timestamp)} ${hour}`
        : hour;
    }
    return new Date(timestamp).toLocaleDateString('en-US', {
      timeZone: 'America/Lima',
      month: 'short',
      day: 'numeric',
      ...(last - first > 365 * 86400_000 ? { year: '2-digit' as const } : {}),
    });
  };
  const gapThreshold = history.aggregation === 'daily' ? 1.5 * 86400_000 : 45 * 60_000;
  const startsSegment = (i: number) =>
    i === 0 ||
    Date.parse(points[i].effective_at) - Date.parse(points[i - 1].effective_at) > gapThreshold;
  // A move-only path segment has no visible stroke. Preserve its capture with
  // markers, without adding a circle for every point in a continuous history.
  const isolated = points.filter(
    (_, i) =>
      (!active || i !== index) &&
      startsSegment(i) &&
      (i === points.length - 1 || startsSegment(i + 1)),
  );
  const path = (side: 'buy' | 'sell') =>
    points.map((p, i) => `${startsSegment(i) ? 'M' : 'L'}${x(p)},${y(p[side])}`).join(' ');
  function select(clientX: number, target: SVGSVGElement) {
    const rect = target.getBoundingClientRect();
    const wanted =
      first +
      Math.max(
        0,
        Math.min(1, (((clientX - rect.left) / rect.width) * width - plotLeft) / plotWidth),
      ) *
        (last - first);
    let nearest = 0;
    points.forEach((p, i) => {
      if (
        Math.abs(Date.parse(p.effective_at) - wanted) <
        Math.abs(Date.parse(points[nearest].effective_at) - wanted)
      )
        nearest = i;
    });
    setSelected(nearest);
    setHoverActive(true);
  }
  return (
    <div className={styles.chart} role="region" aria-label={`${sourceName} USD/PEN history`}>
      <div className={styles.legend} aria-label="Chart series">
        <span>
          <i className={styles.buyKey} aria-hidden="true" />
          Buy
        </span>
        <span>
          <i className={styles.sellKey} aria-hidden="true" />
          Sell
        </span>
      </div>
      <div ref={container} className={styles.plot}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="slider"
          aria-label="History point"
          aria-valuemin={1}
          aria-valuemax={points.length}
          aria-valuenow={index + 1}
          aria-valuetext={`${time(point.effective_at)}; buy ${point.buy}; sell ${point.sell}`}
          tabIndex={0}
          onPointerMove={(e) => select(e.clientX, e.currentTarget)}
          onPointerDown={(e) => {
            setKeyboardActive(false);
            select(e.clientX, e.currentTarget);
          }}
          onPointerLeave={() => setHoverActive(false)}
          onFocus={(e) => setKeyboardActive(e.currentTarget.matches(':focus-visible'))}
          onBlur={() => setKeyboardActive(false)}
          onKeyDown={(e) => {
            const next =
              e.key === 'Home'
                ? 0
                : e.key === 'End'
                  ? points.length - 1
                  : e.key === 'ArrowLeft'
                    ? Math.max(0, index - 1)
                    : e.key === 'ArrowRight'
                      ? Math.min(points.length - 1, index + 1)
                      : null;
            if (next !== null) {
              e.preventDefault();
              setSelected(next);
              setKeyboardActive(true);
            }
          }}
        >
          {yTicks.map((n) => (
            <g key={n}>
              <line x1={plotLeft} x2={plotRight} y1={y(n)} y2={y(n)} className={styles.grid} />
              <text className={styles.axis} x={plotLeft - 7} y={y(n) + 3} textAnchor="end">
                {price(n)}
              </text>
            </g>
          ))}
          <line
            className={styles.axisLine}
            x1={plotLeft}
            x2={plotLeft}
            y1={plotTop}
            y2={plotBottom}
          />
          <line
            className={styles.axisLine}
            x1={plotLeft}
            x2={plotRight}
            y1={plotBottom}
            y2={plotBottom}
          />
          {xTicks.map((timestamp, index) => (
            <g key={timestamp}>
              <line
                className={styles.axisLine}
                x1={tickX(timestamp)}
                x2={tickX(timestamp)}
                y1={plotBottom}
                y2={plotBottom + 4}
              />
              <text
                className={styles.axis}
                x={tickX(timestamp)}
                y={height - 22}
                textAnchor={index === 0 ? 'start' : index === xTicks.length - 1 ? 'end' : 'middle'}
              >
                {tickLabel(timestamp, index)}
              </text>
            </g>
          ))}
          <text
            className={styles.axisTitle}
            x={(plotLeft + plotRight) / 2}
            y={height - 4}
            textAnchor="middle"
          >
            {intraday ? 'Time (Lima)' : 'Date'}
          </text>
          <text
            className={styles.axisTitle}
            x="11"
            y={(plotTop + plotBottom) / 2}
            textAnchor="middle"
            transform={`rotate(-90 11 ${(plotTop + plotBottom) / 2})`}
          >
            PEN per USD
          </text>
          <path d={path('buy')} className={styles.buy} />
          <path d={path('sell')} className={styles.sell} />
          {isolated.map((capture) => (
            <g key={capture.effective_at}>
              <circle cx={x(capture)} cy={y(capture.buy)} r="4" fill="#9bcba6" />
              <circle cx={x(capture)} cy={y(capture.sell)} r="4" fill="#e9ab88" />
            </g>
          ))}
          {active ? (
            <g className={styles.cursorGroup} style={{ transform: `translateX(${x(point)}px)` }}>
              <line x1="0" x2="0" y1={plotTop} y2={plotBottom} className={styles.cursor} />
              <circle
                className={styles.cursorPoint}
                style={{ transform: `translateY(${y(point.buy)}px)` }}
                cx="0"
                cy="0"
                r="4"
                fill="#9bcba6"
              />
              <circle
                className={styles.cursorPoint}
                style={{ transform: `translateY(${y(point.sell)}px)` }}
                cx="0"
                cy="0"
                r="4"
                fill="#e9ab88"
              />
            </g>
          ) : null}
        </svg>
      </div>
      <div className={styles.detail} data-testid="point-detail" aria-live="polite">
        {active ? (
          <>
            <span>{time(point.effective_at)}</span>
            <strong title={`Exact quote: buy ${point.buy}; sell ${point.sell}`}>
              Buy {price(point.buy)} · Sell {price(point.sell)}
            </strong>
          </>
        ) : null}
      </div>
    </div>
  );
}
