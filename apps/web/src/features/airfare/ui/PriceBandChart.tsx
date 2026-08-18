import { useMemo } from 'react';

import type { Bucket, Granularity } from '@/features/airfare/lib/buckets';
import { spanOf } from '@/features/airfare/lib/buckets';
import { formatMoney } from '@/shared/lib/money';

import styles from './PriceBandChart.module.css';

const VIEW = { width: 760, height: 260, pad: { top: 14, right: 16, bottom: 30, left: 62 } };

type PriceBandChartProps = {
  ours: Bucket[];
  baseline: Bucket[];
  currency: string;
  granularity: Granularity;
  label: string;
};

/**
 * What a route has cost, period by period: a band and a middle, with the
 * provider's own history behind it.
 *
 * **Two series that mean different things, drawn so they cannot be confused.**
 * The filled band and its solid line are our own observations — the range and
 * median of the cheapest fare within each period. The dashed line behind is
 * what the provider says the route usually costs: one rounded integer per day,
 * cheapest-only, with no airline and no departure time. Merging them into one
 * line would quietly change what the line measures, which is the mistake this
 * feature has refused to make since a second provider was measured and dropped.
 *
 * A band rather than a single minimum, because the two move for different
 * reasons: a period where the expensive itineraries sold out reads exactly like
 * a quiet one if all you plot is the cheapest.
 *
 * SVG, so every period is a node a test can find and a screen reader can read
 * — decision 12.12, the same choice as the rest of this feature's charts.
 */
export function PriceBandChart({
  ours,
  baseline,
  currency,
  granularity,
  label,
}: PriceBandChartProps) {
  const span = useMemo(() => spanOf(ours, baseline), [ours, baseline]);

  const geometry = useMemo(() => {
    if (!span || ours.length + baseline.length === 0) return null;
    // Never anchored at zero: a fare that moved from 620 to 640 is a real
    // move, and a zero-based axis would draw it as a flat line.
    const padding = Math.max((span.high - span.low) * 0.12, span.high * 0.02, 1);
    const low = Math.max(0, span.low - padding);
    const high = span.high + padding;

    const keys = [...new Set([...baseline, ...ours].map((bucket) => bucket.key))].sort((a, b) =>
      a.localeCompare(b),
    );
    const inner = {
      width: VIEW.width - VIEW.pad.left - VIEW.pad.right,
      height: VIEW.height - VIEW.pad.top - VIEW.pad.bottom,
    };
    const x = (key: string) =>
      VIEW.pad.left +
      (keys.length === 1 ? inner.width / 2 : (keys.indexOf(key) / (keys.length - 1)) * inner.width);
    const y = (value: number) =>
      VIEW.pad.top + (1 - (value - low) / (high - low || 1)) * inner.height;

    const line = (series: Bucket[], pick: (bucket: Bucket) => number) =>
      series
        .map(
          (bucket, index) =>
            `${index ? 'L' : 'M'}${x(bucket.key).toFixed(1)},${y(pick(bucket)).toFixed(1)}`,
        )
        .join('');

    const band =
      ours.length > 1
        ? `${line(ours, (bucket) => bucket.high)}${ours
            .slice()
            .reverse()
            .map((bucket) => `L${x(bucket.key).toFixed(1)},${y(bucket.low).toFixed(1)}`)
            .join('')}Z`
        : '';

    const ticks = [low, (low + high) / 2, high];
    return {
      x,
      y,
      low,
      high,
      keys,
      band,
      ours: line(ours, (b) => b.middle),
      baseline: line(baseline, (b) => b.middle),
      ticks,
    };
  }, [span, ours, baseline]);

  if (!geometry) {
    return (
      <p className={styles.empty}>
        Nothing observed yet for this route. The first collection pass puts a point here — and seeds
        sixty days of the provider&rsquo;s own history behind it.
      </p>
    );
  }

  const unit = granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month';

  return (
    <figure className={styles.figure}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        role="img"
        aria-label={`${label}. ${ours.length} ${unit}${ours.length === 1 ? '' : 's'} observed, from ${formatMoney(geometry.low, currency)} to ${formatMoney(geometry.high, currency)}.`}
      >
        {geometry.ticks.map((value) => (
          <g key={value}>
            <line
              x1={VIEW.pad.left}
              x2={VIEW.width - VIEW.pad.right}
              y1={geometry.y(value)}
              y2={geometry.y(value)}
              className={styles.grid}
            />
            <text x={VIEW.pad.left - 8} y={geometry.y(value) + 4} className={styles.axis}>
              {formatMoney(value, currency)}
            </text>
          </g>
        ))}

        {geometry.baseline ? (
          <path d={geometry.baseline} className={styles.baseline} aria-hidden="true" />
        ) : null}
        {geometry.band ? (
          <path d={geometry.band} className={styles.band} aria-hidden="true" />
        ) : null}
        {geometry.ours ? (
          <path d={geometry.ours} className={styles.middle} aria-hidden="true" />
        ) : null}

        {ours.map((bucket) => (
          <g key={bucket.key} className={styles.point}>
            <title>
              {bucket.label}: {formatMoney(bucket.low, currency)}–
              {formatMoney(bucket.high, currency)}, median {formatMoney(bucket.middle, currency)}{' '}
              across {bucket.count} observation
              {bucket.count === 1 ? '' : 's'}
            </title>
            <circle cx={geometry.x(bucket.key)} cy={geometry.y(bucket.middle)} r={3} />
          </g>
        ))}

        {[geometry.keys[0], geometry.keys.at(-1)].map((key, index) =>
          key ? (
            <text
              key={key}
              x={geometry.x(key)}
              y={VIEW.height - 10}
              className={styles.axis}
              textAnchor={index === 0 ? 'start' : 'end'}
            >
              {[...ours, ...baseline].find((bucket) => bucket.key === key)?.label ?? key}
            </text>
          ) : null,
        )}
      </svg>

      <figcaption className={styles.legend}>
        <span className={styles.keyOurs}>
          <i /> Our observations — range and median per {unit}
        </span>
        <span className={styles.keyBaseline}>
          <i /> What the provider says it usually costs — one rounded figure a day
        </span>
      </figcaption>
    </figure>
  );
}
