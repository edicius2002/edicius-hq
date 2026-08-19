import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { Bucket, BucketAxis } from '@/features/airfare/lib/buckets';
import { contiguousRuns, spanOf } from '@/features/airfare/lib/buckets';
import {
  clampToTrack,
  nearestBucket,
  marginForPrices,
  priceAxisTag,
  readingAt,
  readingSentence,
  timeAxisTag,
  type TagAnchor,
} from '@/features/airfare/lib/crosshair';
import { NO_VALUE, formatMoney } from '@/shared/lib/money';

import styles from './PriceBandChart.module.css';

/**
 * The gap between the price plate and the plot it labels.
 *
 * Left padding is derived from it rather than chosen: the margin has to hold
 * the widest figure `formatMoney` can print for a watched route, and at 62 —
 * the value this chart shipped with — it did not. `S/4,580.00` is an ordinary
 * long-haul fare from this app's default origin and needs 70 units against the
 * 52 that were there, so its leading `S` was painted outside the viewBox. The
 * plot loses 22 units of width to the fix, about 3%, which is a cheap price
 * for never clipping a price.
 */
const PRICE_GAP = 8;

const VIEW = {
  width: 760,
  height: 260,
  pad: { top: 14, right: 16, bottom: 30, left: marginForPrices(PRICE_GAP) },
};

/** The pinned axis plates: how tall, and where the text sits inside one. */
const TAG = { height: 16, baseline: 11.5 };

/**
 * The anchor, as a class rather than as a `text-anchor` attribute.
 *
 * This is the whole fix for a bug that shipped: `.tagText` set `text-anchor:
 * end` in the stylesheet, and a CSS declaration beats a presentation attribute
 * whatever its specificity — so `textAnchor="middle"` on the element was
 * silently ignored and the time label hung off the left edge of its own plate.
 * Going through a class means the anchor is decided in the same language that
 * can override it, and `.tagText` no longer names an anchor at all.
 */
const ANCHOR: Record<TagAnchor, string> = {
  start: styles.tagStart,
  middle: styles.tagMiddle,
  end: styles.tagEnd,
};

type PriceBandChartProps = {
  ours: Bucket[];
  baseline: Bucket[];
  currency: string;
  /**
   * What the x axis is a chart of — 12.170. The geometry below is the same
   * whether the buckets are calendar periods or days before departure; the
   * axis supplies the words and the direction.
   */
  axis: BucketAxis;
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
 * **Two axes, one chart — 12.170.** The buckets arrive already gathered, and
 * whether they were gathered by the day we looked or by how far ahead of
 * departure the price was seen is `axis`'s business rather than this file's.
 * Everything that differs between the two views is in that object: what one
 * bucket is called, how a key is spelled out under the crosshair, and which
 * way the axis runs. Forking this component instead would have meant two
 * copies of the crosshair, and the two bugs 12.61 and 12.62 record were both
 * in the crosshair.
 *
 * SVG, so every period is a node a test can find and a screen reader can read
 * — decision 12.12, the same choice as the rest of this feature's charts. The
 * crosshair is drawn into the same SVG for that reason: on a canvas it would
 * be pixels, and the price under the pointer is a number somebody may want to
 * copy or hear read out.
 */
export function PriceBandChart({ ours, baseline, currency, axis, label }: PriceBandChartProps) {
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

    const keys = [...new Set([...baseline, ...ours].map((bucket) => bucket.key))].sort(axis.order);
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

    /*
     * A path per run of neighbouring buckets, never one path across the lot.
     *
     * A period nobody observed is a hole in a series, and a single `d` drawn
     * straight through it claims the fare moved evenly across a stretch we
     * never looked at. Two subpaths in one `d` leave the hole as a hole, which
     * is the honest drawing and the one the lead-time axis needs — our own
     * archive reaches 31 of that axis's 91 buckets, so most of it is a period
     * we have no figure for.
     */
    const line = (series: Bucket[], pick: (bucket: Bucket) => number) =>
      contiguousRuns(keys, series)
        .map((run) =>
          run
            .map(
              (bucket, index) =>
                `${index ? 'L' : 'M'}${x(bucket.key).toFixed(1)},${y(pick(bucket)).toFixed(1)}`,
            )
            .join(''),
        )
        .join('');

    const band = contiguousRuns(keys, ours)
      .filter((run) => run.length > 1)
      .map(
        (run) =>
          `${run
            .map(
              (bucket, index) =>
                `${index ? 'L' : 'M'}${x(bucket.key).toFixed(1)},${y(bucket.high).toFixed(1)}`,
            )
            .join('')}${run
            .slice()
            .reverse()
            .map((bucket) => `L${x(bucket.key).toFixed(1)},${y(bucket.low).toFixed(1)}`)
            .join('')}Z`,
      )
      .join('');

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
  }, [span, ours, baseline, axis]);

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
    geometry && active !== null ? readingAt(geometry.keys[active], ours, baseline, axis) : null;

  if (!geometry) {
    return (
      <p className={styles.empty}>
        Nothing observed yet for this route. The first collection pass puts a point here — and seeds
        sixty days of the provider&rsquo;s own history behind it.
      </p>
    );
  }

  const unit = axis.unit.one;

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
  const priceTagY = clampToTrack(hairY, TAG.height, VIEW.pad.top, VIEW.height - VIEW.pad.bottom);
  const priceTag = priceAxisTag(VIEW.pad.left - PRICE_GAP, formatMoney(hairPrice, currency));
  const timeTag = timeAxisTag(
    hairX,
    reading?.label ?? '',
    VIEW.pad.left,
    VIEW.width - VIEW.pad.right,
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
        aria-label={`${label}. ${ours.length} ${ours.length === 1 ? axis.unit.one : axis.unit.many} observed, from ${formatMoney(geometry.low, currency)} to ${formatMoney(geometry.high, currency)}.`}
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
            <text
              x={VIEW.pad.left - PRICE_GAP}
              y={geometry.y(value) + 4}
              className={`${styles.axis} ${styles.tagEnd}`}
            >
              {formatMoney(value, currency)}
            </text>
          </g>
        ))}

        {geometry.baseline ? (
          <path d={geometry.baseline} className={styles.baseline} aria-hidden="true" />
        ) : null}
        {geometry.band ? (
          <path
            d={geometry.band}
            className={styles.band}
            aria-hidden="true"
            data-testid="ours-band"
          />
        ) : null}
        {geometry.ours ? (
          <path
            d={geometry.ours}
            className={styles.middle}
            aria-hidden="true"
            data-testid="ours-line"
          />
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
              className={`${styles.axis} ${index === 0 ? styles.tagStart : styles.tagEnd}`}
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
              x={priceTag.x}
              y={priceTagY}
              width={priceTag.width}
              height={TAG.height}
              rx={3}
              className={styles.tag}
            />
            <text
              x={priceTag.textX}
              y={priceTagY + TAG.baseline}
              className={`${styles.tagText} ${ANCHOR[priceTag.anchor]}`}
              data-testid="price-tag-text"
            >
              {formatMoney(hairPrice, currency)}
            </text>

            <rect
              x={timeTag.x}
              y={VIEW.height - VIEW.pad.bottom + 3}
              width={timeTag.width}
              height={TAG.height}
              rx={3}
              className={styles.tag}
              data-testid="time-tag-plate"
            />
            <text
              x={timeTag.textX}
              y={VIEW.height - VIEW.pad.bottom + 3 + TAG.baseline}
              className={`${styles.tagText} ${ANCHOR[timeTag.anchor]}`}
              data-testid="time-tag-text"
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
          <i /> {axis.baselineLegend}
        </span>
      </figcaption>
    </figure>
  );
}
