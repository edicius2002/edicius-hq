import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { Bucket, BucketAxis, UnsoldPeriod } from '@/features/airfare/lib/buckets';
import { contiguousRuns, spanOf } from '@/features/airfare/lib/buckets';
import { niceTicks } from '@/features/airfare/lib/scales';
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

/*
 * Twenty-four units taller in the bottom margin than this chart used to be, and
 * they are the horizon chart's twenty-four — 12.232. One is the rail the empty
 * boards are marked on, which cannot sit inside the plot because a mark at any
 * height in there reads as a fare. The other is that the two end labels keep
 * their own row below the crosshair's tag rather than being covered by it.
 * Matching that chart unit for unit is deliberate: the two draw the same kinds
 * of absence and a reader moving between them should not have to relearn where
 * a mark lives.
 */
const VIEW = {
  width: 760,
  height: 284,
  pad: { top: 14, right: 16, bottom: 48, left: marginForPrices(PRICE_GAP) },
};

const PLOT_BOTTOM = VIEW.height - VIEW.pad.bottom;
/** Where a period whose boards came back empty is marked, just under the plot floor. */
const RAIL_Y = PLOT_BOTTOM + 7;
/** The pinned axis plates: how tall, where the time one sits, and its baseline. */
const TAG = { height: 16, top: PLOT_BOTTOM + 16, baseline: 11.5 };
/** The axis labels sit below the tag, on their own row. */
const AXIS_BASELINE = VIEW.height - 4;

/**
 * How close two x-axis labels may come before one of them is dropped.
 *
 * The widest label this axis prints is a lead-time range — `189–195d ahead`, 13
 * glyphs at `TAG_CHAR_WIDTH` — so 90 units is a label's own width and a little
 * air. Labelling by spacing rather than by "every nth key" is what keeps the
 * axis readable now that it is a measure: with keys spaced by time, every nth
 * key can be two labels on top of each other in one place and none at all in
 * the next.
 */
const LABEL_MIN_SPACING = 90;

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
  /**
   * Periods we looked at and found nothing on sale in — 12.232. Optional, and
   * an empty list is the ordinary case; a chart handed none simply draws no
   * rail, exactly as it did before the distinction existed.
   */
  unsold?: UnsoldPeriod[];
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

/** A shared empty list, so a chart handed no unsold periods does not rebuild its geometry every render. */
const EMPTY_UNSOLD: UnsoldPeriod[] = [];

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
export function PriceBandChart({
  ours,
  baseline,
  unsold = EMPTY_UNSOLD,
  currency,
  axis,
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

    /*
     * Every period either series reached, and every one we reached and found
     * empty — 12.232. The last of those three is why an unsold period is on the
     * axis at all: it is a period we have a reading for, and the reading is
     * "there was nothing to sell".
     */
    const keys = [...new Set([...baseline, ...ours, ...unsold].map((entry) => entry.key))].sort(
      axis.order,
    );
    const inner = {
      width: VIEW.width - VIEW.pad.left - VIEW.pad.right,
      height: PLOT_BOTTOM - VIEW.pad.top,
    };

    /*
     * Placed by when a period is, never by where it falls in the list — 12.231.
     *
     * Spacing by index made a fortnight the collector was down the same width
     * as a one-day step, and gave a period neither series reached no width at
     * all: the two observations either side of an outage were joined by a
     * segment indistinguishable from any other. The axis is in days now, taken
     * from `axis.position`, so the distance across a gap is the gap. It is the
     * same measure on both readings — calendar days from the epoch, or days
     * before departure counted backwards — which is what lets one component
     * keep drawing both.
     *
     * A hole is still a hole: `contiguousRuns` below breaks a line wherever a
     * period on the axis has no figure in that series, and a stretch with no
     * period on the axis at all is now plainly as wide as it was long.
     */
    const positions = keys.map(axis.position);
    const from = Math.min(...positions);
    const to = Math.max(...positions);
    const x = (key: string) =>
      VIEW.pad.left +
      (to === from ? inner.width / 2 : ((axis.position(key) - from) / (to - from)) * inner.width);
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

    /*
     * Round numbers inside the padded band, never the padded band's own ends —
     * 12.233. Those ends are geometry: the domain is stretched by a padding
     * term so the extremes are not drawn on the frame. Printing them as money
     * turned that padding into three fares nobody was quoted, in the same
     * format as the fares that were. `niceTicks` states the whole argument.
     */
    const ticks = niceTicks(low, high);

    /*
     * As many x labels as fit without touching, at their own true positions.
     *
     * Two labels — the first key and the last — was all this axis carried, and
     * on an axis spaced by index that was almost defensible because the middle
     * held no information. On one spaced by time it is the opposite: the middle
     * is where the reader sees that a stretch is a fortnight rather than a day,
     * and two end labels are not enough to read a distance from.
     */
    const labelled: string[] = [];
    let lastLabelX = Number.NEGATIVE_INFINITY;
    for (const key of keys) {
      if (x(key) - lastLabelX < LABEL_MIN_SPACING) continue;
      labelled.push(key);
      lastLabelX = x(key);
    }
    // The last period is the one a reader looks for first — it is where the
    // series ends — so it is labelled even if that means dropping the label
    // before it.
    const last = keys.at(-1);
    if (last !== undefined && labelled.at(-1) !== last) {
      if (labelled.length > 0 && x(last) - x(labelled.at(-1)!) < LABEL_MIN_SPACING) labelled.pop();
      labelled.push(last);
    }

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
      labelled,
      ticks,
      /** What was actually observed, as opposed to the frame it is drawn in. */
      observed: span,
    };
  }, [span, ours, baseline, unsold, axis]);

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
      ? readingAt(geometry.keys[active], ours, baseline, axis, unsold)
      : null;

  if (!geometry) {
    return (
      <p className={styles.empty}>
        Nothing observed yet for this route. The first collection pass puts a point here — and seeds
        sixty days of the provider&rsquo;s own history behind it.
      </p>
    );
  }

  const unit = axis.unit.one;

  /*
   * The observed span, not the padded one — 12.233. `geometry.low` and
   * `geometry.high` are the frame the plot is drawn inside, and since the
   * padding term is a tenth of the range they are two figures nobody was ever
   * quoted. This sentence is where a reader who cannot see the plot learns what
   * the route actually cost, so it states the range the data has.
   */
  const accessibleName = `${label}. ${ours.length} ${ours.length === 1 ? axis.unit.one : axis.unit.many} observed, from ${formatMoney(geometry.observed.low, currency)} to ${formatMoney(geometry.observed.high, currency)}.`;

  const hairX = active === null ? 0 : geometry.positions[active];
  /*
   * A keyboard reader has no pointer height, so the horizontal hairline sits on
   * the period's own median — the number the solid line is drawn at.
   *
   * Null where there is no such number — 12.234. The fallback used to be the
   * middle of the padded domain, which meant that arrowing onto a period with
   * no figure printed the halfway point of an invented range as currency, on a
   * plate, at a height chosen by the padding term. The readout beside it said
   * `—` and the live region said so in words, and the plate contradicted both.
   * Nothing is drawn now: no horizontal hair, no price plate. Under a *pointer*
   * both stay, because there the hairline is a ruler the reader is holding at a
   * height of their own choosing rather than a claim about the period.
   */
  const hairY =
    reading === null
      ? null
      : (cursor?.y ?? (reading.ours ? geometry.y(reading.ours.middle) : null));
  const hairPrice = hairY === null ? null : geometry.priceAt(hairY);
  const priceTagY = hairY === null ? 0 : clampToTrack(hairY, TAG.height, VIEW.pad.top, PLOT_BOTTOM);
  const priceTag = priceAxisTag(
    VIEW.pad.left - PRICE_GAP,
    hairPrice === null ? '' : formatMoney(hairPrice, currency),
  );
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
        aria-label={accessibleName}
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

        {/* The floor the empty-board marks hang under, so the rail is a place rather than loose glyphs. */}
        <line
          x1={VIEW.pad.left}
          x2={VIEW.width - VIEW.pad.right}
          y1={PLOT_BOTTOM}
          y2={PLOT_BOTTOM}
          className={styles.floor}
        />

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

        {/*
          A period we looked at and found nothing on sale in — 12.232. Under
          the plot floor rather than on it, because a mark inside the plot at
          any height is a price, and "there were no fares" is the one thing that
          must not be drawn as one. A blank stretch of axis beside it means
          something different and now says so by being as wide as it is long:
          nobody looked.
        */}
        {unsold.map((period) =>
          geometry.keys.includes(period.key) ? (
            <g key={period.key} className={styles.hole} data-testid="unsold-mark">
              <title>
                {period.label}: nothing on sale — {period.count} board
                {period.count === 1 ? '' : 's'} came back empty
              </title>
              <rect
                x={geometry.x(period.key) - 1.6}
                y={RAIL_Y - 1.6}
                width={3.2}
                height={3.2}
                className={styles.unsold}
              />
            </g>
          ) : null,
        )}

        {geometry.labelled.map((key, index) => (
          <text
            key={key}
            x={geometry.x(key)}
            y={AXIS_BASELINE}
            className={`${styles.axis} ${
              index === 0
                ? styles.tagStart
                : index === geometry.labelled.length - 1
                  ? styles.tagEnd
                  : styles.tagMiddle
            }`}
          >
            {[...ours, ...baseline, ...unsold].find((entry) => entry.key === key)?.label ?? key}
          </text>
        ))}

        {/*
          The crosshair itself, last so it sits over both series, and
          `aria-hidden` because everything it says is said in words in the live
          region below — a screen reader that walked these nodes would hear the
          same numbers twice, once as geometry.
        */}
        {reading ? (
          <g className={styles.crosshair} aria-hidden="true" data-testid="crosshair">
            <line x1={hairX} x2={hairX} y1={VIEW.pad.top} y2={RAIL_Y + 5} className={styles.hair} />
            {hairY === null || hairPrice === null ? null : (
              <>
                <line
                  x1={VIEW.pad.left}
                  x2={VIEW.width - VIEW.pad.right}
                  y1={hairY}
                  y2={hairY}
                  className={styles.hair}
                />
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
              </>
            )}
            {reading.ours ? (
              <circle
                cx={hairX}
                cy={geometry.y(reading.ours.middle)}
                r={4.5}
                className={styles.marker}
              />
            ) : null}

            <rect
              x={timeTag.x}
              y={TAG.top}
              width={timeTag.width}
              height={TAG.height}
              rx={3}
              className={styles.tag}
              data-testid="time-tag-plate"
            />
            <text
              x={timeTag.textX}
              y={TAG.top + TAG.baseline}
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
            {reading.unsold > 0 ? (
              <span className={styles.absence}>
                {reading.unsold} board{reading.unsold === 1 ? '' : 's'} with nothing on sale
              </span>
            ) : null}
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
        {unsold.length > 0 ? (
          <span className={styles.keyUnsold}>
            <i /> Nothing on sale — we asked and the board came back empty
          </span>
        ) : null}
        {/*
          The one absence with no glyph, said in words instead — 12.231. There
          is nothing in the archive that records a day we meant to look and did
          not, so there is no mark to draw for it; what says it is the axis,
          which is spaced by time and leaves a stretch nobody reached as wide as
          it really was.
        */}
        <span className={styles.keyGap}>
          <i /> A blank stretch is time nobody looked at — the axis is spaced by date
        </span>
      </figcaption>
    </figure>
  );
}
