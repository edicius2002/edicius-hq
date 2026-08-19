import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { Bucket, Granularity } from '@/features/airfare/lib/buckets';
import { spanOf } from '@/features/airfare/lib/buckets';
import {
  clampToTrack,
  nearestBucket,
  readingAt,
  readingSentence,
} from '@/features/airfare/lib/crosshair';
import { NO_VALUE, formatMoney } from '@/shared/lib/money';

import styles from './PriceBandChart.module.css';

const VIEW = { width: 760, height: 260, pad: { top: 14, right: 16, bottom: 30, left: 62 } };

/**
 * The pinned axis labels, in view units.
 *
 * The time label's width is estimated from its own text because the three
 * granularities write very different things — `08-18` against `2026 wk 34` —
 * and a box sized for the longest would sit visibly off-centre under the
 * shortest. Six units a character is measured against the 10px axis font in
 * this viewBox; the constant is a floor so a two-character label still gets a
 * box rather than a sliver.
 */
const TAG = { height: 16, charWidth: 6, minWidth: 40, padding: 10 };

type PriceBandChartProps = {
  ours: Bucket[];
  baseline: Bucket[];
  currency: string;
  granularity: Granularity;
  label: string;
};

/**
 * Where the crosshair is: which period, and how high up the pointer was.
 *
 * `y` is null for a keyboard reader, who has no pointer height to speak of and
 * gets the period's own median instead. Keeping it null rather than
 * pre-resolving it to a number matters because the median is only known once
 * the geometry exists, and the geometry is rebuilt whenever the data changes
 * under a crosshair that is already up.
 */
type Cursor = { index: number; y: number | null };

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
 * — decision 12.12, the same choice as the rest of this feature's charts. The
 * crosshair is drawn into the same SVG for that reason: on a canvas it would
 * be pixels, and the price under the pointer is a number somebody may want to
 * copy or hear read out.
 */
export function PriceBandChart({
  ours,
  baseline,
  currency,
  granularity,
  label,
}: PriceBandChartProps) {
  const span = useMemo(() => spanOf(ours, baseline), [ours, baseline]);
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const help = useId();
  const status = useId();

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
    // The inverse of `y`, for the price the pointer itself is at rather than
    // the price of anything drawn. Clamped, so a pointer in the axis margin
    // reports the end of the band instead of a fare outside the chart.
    const priceAt = (position: number) => {
      const ratio = 1 - (position - VIEW.pad.top) / (inner.height || 1);
      return low + Math.min(Math.max(ratio, 0), 1) * (high - low);
    };

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
      priceAt,
      low,
      high,
      keys,
      positions: keys.map((key) => x(key)),
      band,
      ours: line(ours, (b) => b.middle),
      baseline: line(baseline, (b) => b.middle),
      ticks,
    };
  }, [span, ours, baseline]);

  /*
   * The crosshair, resolved against the geometry that exists right now.
   *
   * Held as a derived value rather than as more state because the data under
   * it changes: flipping the switch from week to month rebuilds the keys, and
   * an index kept from before would point past the end of the new array. A
   * stale index resolves to nothing here and the crosshair simply goes away,
   * which is the honest outcome — the period it was on no longer exists.
   */
  const active =
    geometry && cursor !== null && cursor.index >= 0 && cursor.index < geometry.keys.length
      ? cursor.index
      : null;
  const reading =
    geometry && active !== null
      ? readingAt(geometry.keys[active], ours, baseline, granularity)
      : null;

  if (!geometry) {
    return (
      <p className={styles.empty}>
        Nothing observed yet for this route. The first collection pass puts a point here — and seeds
        sixty days of the provider&rsquo;s own history behind it.
      </p>
    );
  }

  const unit = granularity === 'day' ? 'day' : granularity === 'week' ? 'week' : 'month';

  const hairX = active === null ? 0 : geometry.positions[active];
  // A keyboard reader has no pointer height, so the horizontal hairline sits on
  // the period's own median — the number the solid line is drawn at.
  const hairY =
    reading === null
      ? 0
      : (cursor?.y ??
        (reading.ours
          ? geometry.y(reading.ours.middle)
          : VIEW.pad.top + (VIEW.height - VIEW.pad.top - VIEW.pad.bottom) / 2));
  const hairPrice = geometry.priceAt(hairY);
  const timeTagWidth = Math.max(
    TAG.minWidth,
    (reading?.label.length ?? 0) * TAG.charWidth + TAG.padding,
  );

  /** Pointer position in the units the viewBox is drawn in, never in pixels. */
  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const x = ((event.clientX - box.left) / box.width) * VIEW.width;
    const y = ((event.clientY - box.top) / box.height) * VIEW.height;
    const index = nearestBucket(geometry.positions, x);
    if (index === null) return;
    setCursor({ index, y });
  };

  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // Otherwise the arrow scrolls the page out from under the chart the reader
    // is trying to read.
    event.preventDefault();
    const forward = event.key === 'ArrowRight';
    // Arriving from nothing, the first press lands on the end the reader is
    // moving away from: right starts at the oldest period, left at the newest.
    const from = active ?? (forward ? -1 : geometry.keys.length);
    setCursor({
      index: Math.min(Math.max(from + (forward ? 1 : -1), 0), geometry.keys.length - 1),
      y: null,
    });
  };

  return (
    <figure className={styles.figure}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        role="img"
        tabIndex={0}
        aria-label={`${label}. ${ours.length} ${unit}${ours.length === 1 ? '' : 's'} observed, from ${formatMoney(geometry.low, currency)} to ${formatMoney(geometry.high, currency)}.`}
        aria-describedby={`${help} ${status}`}
        onPointerMove={trackPointer}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={step}
        onBlur={() => setCursor(null)}
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

        {/*
          The crosshair itself, last so it sits over both series, and
          `aria-hidden` because everything it says is said in words in the live
          region below — a screen reader that walked these nodes would hear the
          same numbers twice, once as geometry.
        */}
        {reading ? (
          <g className={styles.crosshair} aria-hidden="true" data-testid="crosshair">
            <line
              x1={hairX}
              x2={hairX}
              y1={VIEW.pad.top}
              y2={VIEW.height - VIEW.pad.bottom}
              className={styles.hair}
            />
            <line
              x1={VIEW.pad.left}
              x2={VIEW.width - VIEW.pad.right}
              y1={hairY}
              y2={hairY}
              className={styles.hair}
            />
            {reading.ours ? (
              <circle
                cx={hairX}
                cy={geometry.y(reading.ours.middle)}
                r={4.5}
                className={styles.marker}
              />
            ) : null}

            <rect
              x={2}
              y={clampToTrack(hairY, TAG.height, VIEW.pad.top, VIEW.height - VIEW.pad.bottom)}
              width={VIEW.pad.left - 8}
              height={TAG.height}
              rx={3}
              className={styles.tag}
            />
            <text
              x={VIEW.pad.left - 8}
              y={
                clampToTrack(hairY, TAG.height, VIEW.pad.top, VIEW.height - VIEW.pad.bottom) + 11.5
              }
              className={styles.tagText}
            >
              {formatMoney(hairPrice, currency)}
            </text>

            <rect
              x={clampToTrack(hairX, timeTagWidth, VIEW.pad.left, VIEW.width - VIEW.pad.right)}
              y={VIEW.height - VIEW.pad.bottom + 3}
              width={timeTagWidth}
              height={TAG.height}
              rx={3}
              className={styles.tag}
            />
            <text
              x={
                clampToTrack(hairX, timeTagWidth, VIEW.pad.left, VIEW.width - VIEW.pad.right) +
                timeTagWidth / 2
              }
              y={VIEW.height - VIEW.pad.bottom + 14.5}
              className={styles.tagText}
              textAnchor="middle"
            >
              {reading.label}
            </text>
          </g>
        ) : null}
      </svg>

      {/*
        The readout is HTML rather than more SVG so it can wrap, use the app's
        own type scale, and be a live region. It keeps its height whether or not
        a crosshair is up: a strip that appears on hover would shove the flight
        table down the page every time the pointer crossed the chart.
      */}
      <p className={styles.readout} aria-hidden="true">
        {reading === null ? (
          <span className={styles.hint}>
            Point at the chart, or press the arrow keys, to read a {unit}.
          </span>
        ) : (
          <>
            <strong>{reading.label}</strong>
            <span className={styles.period}>{reading.period}</span>
            <span>
              {reading.ours
                ? `${formatMoney(reading.ours.low, currency)}–${formatMoney(reading.ours.high, currency)}`
                : NO_VALUE}
            </span>
            <span>
              median {reading.ours ? formatMoney(reading.ours.middle, currency) : NO_VALUE}
            </span>
            <span>
              baseline{' '}
              {reading.baseline === null ? NO_VALUE : formatMoney(reading.baseline, currency)}
            </span>
          </>
        )}
      </p>

      <p id={help} className={styles.srOnly}>
        Left and right arrow keys move the crosshair one {unit} at a time and read out that
        period&rsquo;s figures.
      </p>
      <p id={status} className={styles.srOnly} role="status">
        {reading === null ? '' : readingSentence(reading, currency)}
      </p>

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
