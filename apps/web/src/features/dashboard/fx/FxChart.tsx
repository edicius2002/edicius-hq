import { useState } from 'react';
import { useElementSize } from '@/shared/lib/useElementSize';
import type { History } from './types';
import { price, time } from './model';
import styles from './FxChart.module.css';
export function FxChart({ history, sourceName }: { history: History; sourceName: string }) {
  const [selected, setSelected] = useState<number | null>(null);
  const [container, size] = useElementSize<HTMLDivElement>();
  const width = size.width || 320;
  const height = size.height || 120;
  const plotWidth = Math.max(1, width - 65);
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
  const x = (p: typeof point) =>
    50 + (last === first ? 0.5 : (Date.parse(p.effective_at) - first) / (last - first)) * plotWidth;
  const y = (n: number) => height - 22 - ((n - lo) / (hi - lo)) * (height - 34);
  const gapThreshold = history.aggregation === 'daily' ? 1.5 * 86400_000 : 45 * 60_000;
  const startsSegment = (i: number) =>
    i === 0 ||
    Date.parse(points[i].effective_at) - Date.parse(points[i - 1].effective_at) > gapThreshold;
  // A move-only path segment has no visible stroke. Preserve its capture with
  // markers, without adding a circle for every point in a continuous history.
  const isolated = points.filter(
    (_, i) => i !== index && startsSegment(i) && (i === points.length - 1 || startsSegment(i + 1)),
  );
  const path = (side: 'buy' | 'sell') =>
    points.map((p, i) => `${startsSegment(i) ? 'M' : 'L'}${x(p)},${y(p[side])}`).join(' ');
  function select(clientX: number, target: SVGSVGElement) {
    const rect = target.getBoundingClientRect();
    const wanted =
      first +
      Math.max(0, Math.min(1, (((clientX - rect.left) / rect.width) * width - 50) / plotWidth)) *
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
  }
  return (
    <div className={styles.chart} role="region" aria-label={`${sourceName} USD/PEN history`}>
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
          onPointerDown={(e) => select(e.clientX, e.currentTarget)}
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
            }
          }}
        >
          {[lo, (lo + hi) / 2, hi].map((n) => (
            <g key={n}>
              <line x1="50" x2={width - 15} y1={y(n)} y2={y(n)} className={styles.grid} />
              <text x="43" y={y(n) + 3} textAnchor="end">
                {price(n)}
              </text>
            </g>
          ))}
          <path d={path('buy')} className={styles.buy} />
          <path d={path('sell')} className={styles.sell} />
          {isolated.map((capture) => (
            <g key={capture.effective_at}>
              <circle cx={x(capture)} cy={y(capture.buy)} r="4" fill="#9bcba6" />
              <circle cx={x(capture)} cy={y(capture.sell)} r="4" fill="#e9ab88" />
            </g>
          ))}
          <line x1={x(point)} x2={x(point)} y1="8" y2={height - 18} className={styles.cursor} />
          <circle cx={x(point)} cy={y(point.buy)} r="4" fill="#9bcba6" />
          <circle cx={x(point)} cy={y(point.sell)} r="4" fill="#e9ab88" />
          <text x="50" y={height - 7}>
            {new Date(first).toLocaleDateString('en-US', {
              timeZone: 'America/Lima',
              month: 'short',
              day: 'numeric',
            })}
          </text>
          <text x={width - 15} y={height - 7} textAnchor="end">
            {new Date(last).toLocaleDateString('en-US', {
              timeZone: 'America/Lima',
              month: 'short',
              day: 'numeric',
            })}
          </text>
        </svg>
      </div>
      <div className={styles.detail} data-testid="point-detail" aria-live="polite">
        <span>{time(point.effective_at)}</span>
        <strong title={`Exact quote: buy ${point.buy}; sell ${point.sell}`}>
          Buy {price(point.buy)} · Sell {price(point.sell)}
        </strong>
      </div>
    </div>
  );
}
