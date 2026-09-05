import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import type { Bucket, BucketAxis, UnsoldPeriod } from '@/features/airfare/lib/buckets';
import { contiguousRuns, spanOf } from '@/features/airfare/lib/buckets';
import { niceTicks } from '@/features/airfare/lib/scales';
import {
  AXIS_PRICE_WORDS,
  axisPrice,
  axisPriceSentence,
  clampToTrack,
  nearestBucket,
  marginForPrices,
  pointerInView,
  priceAxisTag,
  readingAt,
  readingSentence,
  timeAxisTag,
  type TagAnchor,
} from '@/features/airfare/lib/crosshair';
import { NO_VALUE, formatMoney } from '@/shared/lib/money';
import { useElementSize } from '@/shared/lib/useElementSize';

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

/**
 * The horizontal units this chart is drawn in when its box is narrow.
 *
 * **Only the width changes, and that is the whole trick.** Everything below is
 * derived from `VIEW.height` and `VIEW.pad.bottom`, so a narrower view leaves
 * the vertical geometry — the plot floor, the rail, the axis plates — exactly
 * where it was. What it changes is the scale the browser draws at, because the
 * same pixels now carry fewer units.
 *
 * Measured on a 360px phone before this existed: the figure is 223px wide, so
 * 760 units mapped at 0.293 and the ink stood 73px tall inside a 125px box.
 * The box was not the constraint and never had been — a plot drawn to its own
 * aspect from its width does not get taller when its box does. 505 units map
 * the same 223px at 0.442, which draws the ink at about 110px: half again as
 * large, in the box it already had.
 *
 * 505 is derived from that box. The drawing is `VIEW.height` units tall, so it
 * fills a 125px box when `223 / width = 125 / 284` — width 506, rounded down so
 * the height binds a pixel before the width does and nothing is letterboxed
 * sideways.
 */
const COMPACT_VIEW_WIDTH = 505;

/**
 * The width below which the compact geometry is used, in CSS pixels of figure.
 *
 * Not a viewport breakpoint: this chart is given its width by whatever panel
 * holds it, and the question here is only ever "how many pixels do I have".
 * 400 sits above the 223px a 360px phone leaves and below the ~700px the
 * narrowest desktop column gives.
 */
const COMPACT_BELOW_PX = 400;

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
 * The same rule at the compact geometry, where the labels are drawn larger.
 *
 * **This number tracks a font size in the stylesheet, and the two have to move
 * together.** `.axis` is 10 units at desktop and 18 in the narrow block of
 * `PriceBandChart.module.css`, so a label is 1.8x the width it was; a spacing
 * left at 90 lets two of them overlap, which is what it did — measured on a
 * 360px phone, `06-19` and `07-07` printed into each other. 90 x 1.8 is 162.
 *
 * Retune it the same way it was derived: a label's own width and a little air,
 * at whatever size that stylesheet is setting.
 */
const COMPACT_LABEL_MIN_SPACING = 162;

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
 * Where the crosshair is: which period, and nothing else — 12.245.
 *
 * **The pointer's height used to be part of this and is not any more.** The
 * price plate followed the hand up and down the plot, so it printed, in the
 * app's money format, on the one visual element on this chart that looks like a
 * quoted fare, a number nobody was ever quoted — an audit flagged it and it was
 * the reading a mouse gave by default. The plate is a readout of the series
 * now: it snaps to what the route actually cost on the date under the vertical
 * hairline, so walking across the chart reads out each day's own price.
 *
 * An index and not a key, because the geometry is rebuilt whenever the data
 * changes and an index that no longer points at a period resolves to nothing —
 * which is the honest outcome, the period it was on is gone.
 */
type Cursor = number;

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

  /*
   * The figure measures itself and picks its horizontal units from what it
   * finds — see `COMPACT_VIEW_WIDTH`.
   *
   * Measured rather than handed a breakpoint, because the question this answers
   * is "how many pixels do I have", and the panel that holds this chart is not
   * the viewport. It also means the chart is right at every width rather than
   * at two.
   *
   * Zero is the width before the first measurement, and in jsdom it is the
   * width always — `ResizeObserver` is stubbed there — so the desktop geometry
   * is what every existing test keeps seeing.
   */
  const [frame, frameSize] = useElementSize<HTMLElement>();
  const compact = frameSize.width > 0 && frameSize.width < COMPACT_BELOW_PX;
  const viewWidth = compact ? COMPACT_VIEW_WIDTH : VIEW.width;
  const labelMinSpacing = compact ? COMPACT_LABEL_MIN_SPACING : LABEL_MIN_SPACING;

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
      width: viewWidth - VIEW.pad.left - VIEW.pad.right,
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
      if (x(key) - lastLabelX < labelMinSpacing) continue;
      labelled.push(key);
      lastLabelX = x(key);
    }
    // The last period is the one a reader looks for first — it is where the
    // series ends — so it is labelled even if that means dropping the label
    // before it.
    const last = keys.at(-1);
    if (last !== undefined && labelled.at(-1) !== last) {
      if (labelled.length > 0 && x(last) - x(labelled.at(-1)!) < labelMinSpacing) labelled.pop();
      labelled.push(last);
    }

    return {
      x,
      y,
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
  }, [span, ours, baseline, unsold, axis, viewWidth, labelMinSpacing]);

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
    geometry && cursor !== null && cursor >= 0 && cursor < geometry.keys.length ? cursor : null;
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
  /*
   * And what the plate on the price axis is, in words rather than in ink.
   *
   * The plate reads one series on some dates and the other on the rest — see
   * `axisPrice` — so a reader who cannot see which of the two treatments it is
   * wearing needs the rule stated somewhere that does not move. Stated here
   * because it is a property of the chart rather than of the period under the
   * hairline: a name that rewrote itself on every pointer move would be a live
   * region wearing an accessible name's clothes, and the live region below
   * already says which series each individual reading came from.
   *
   * Only where there is a baseline to fall back to. On a chart drawn from our
   * own observations alone the sentence describes a case that cannot arise, and
   * a screen reader hears the accessible name in full before anything else.
   */
  const accessibleName =
    `${label}. ${ours.length} ${ours.length === 1 ? axis.unit.one : axis.unit.many} observed, from ${formatMoney(geometry.observed.low, currency)} to ${formatMoney(geometry.observed.high, currency)}.` +
    (baseline.length > 0
      ? ` The price axis shows ${AXIS_PRICE_WORDS.ours} where we have one for that ${unit}, and ${AXIS_PRICE_WORDS.baseline} where we do not.`
      : '');

  const hairX = active === null ? 0 : geometry.positions[active];
  /*
   * The horizontal hairline sits on the period's own median — the number the
   * solid line is drawn at — for the pointer and the keyboard alike, 12.245.
   *
   * It used to sit wherever the pointer was, and the plate beside it printed
   * that height as money. That made the plate a ruler: a reader sweeping across
   * the chart at a constant height read the same invented fare on every day of
   * the series, in the same format as the fares that were quoted. Snapping it to
   * the series is what turns the two hairlines from a measuring instrument into
   * a readout — move along the chart and the plate says what each day actually
   * cost.
   *
   * **On a period with no median of ours it now sits on the provider's
   * baseline, labelled as the provider's.** That is `axisPrice`'s rule and it
   * is the one thing about this plate that has changed: the source is still a
   * series, and the pointer's height is still not one of the candidates. Our
   * archive is young and the provider ships sixty days behind it, so the median
   * is missing on most dates of this chart — the plate was absent across nearly
   * the whole series, which is a readout nobody learns to read. The baseline
   * has a figure on nearly every date; it is the worse number and it is a real
   * one, and it was already named in the readout and the live region. What is
   * new is that it reaches the axis, and that the plate says whose it is.
   *
   * Still null where neither series reached the period — 12.234 in full, for
   * the pointer and the keyboard alike. The old fallback there was the middle
   * of the padded domain, which printed the halfway point of an invented range
   * as currency; the pointer's own height is no better a source for it, and
   * neither is anything else. Nothing is drawn: no horizontal hair, no plate.
   */
  const hairPrice = axisPrice(reading);
  const hairY = hairPrice === null ? null : geometry.y(hairPrice.value);
  const priceTagY = hairY === null ? 0 : clampToTrack(hairY, TAG.height, VIEW.pad.top, PLOT_BOTTOM);
  const priceTag = priceAxisTag(
    VIEW.pad.left - PRICE_GAP,
    hairPrice === null ? '' : formatMoney(hairPrice.value, currency),
  );
  /*
   * The plate wears the series it reads, in the grammar this chart already
   * teaches — the solid accent line and its filled plate, the muted dashed
   * baseline and a plate outlined in the same dash. Two words would say it
   * better and there is no room for them: the margin is 76 view units, which
   * `S/12,458.00` fills on its own. So the ink carries the attribution and the
   * words carry it everywhere ink cannot be read — the accessible name states
   * the rule, the live region names the series on every reading, and the
   * readout under the plot names it too.
   */
  const fromBaseline = hairPrice?.source === 'baseline';
  const timeTag = timeAxisTag(
    hairX,
    reading?.label ?? '',
    VIEW.pad.left,
    viewWidth - VIEW.pad.right,
  );

  /** Pointer position in the units the viewBox is drawn in, never in pixels. */
  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const at = pointerInView(box, VIEW, event.clientX, event.clientY);
    if (at === null) return;
    // Only the horizontal position is read. The pointer's height no longer
    // decides anything on this chart — 12.245 — so `y` is computed and
    // discarded rather than being a second thing to keep right.
    //
    // This chart letterboxes at every chart width from 373 to 1638 px, measured
    // in Chrome on 2026-08-22, so `pointerInView` returns exactly what dividing
    // by the box's width used to and the change is a no-op wherever anyone has
    // looked. It is here anyway. The old formula was the same latent bug chart B
    // was actually shipping; which way a drawing boxes is a fact about `.body`'s
    // height rather than about this chart; and this one starts to pillarbox at
    // about 1658 px of chart, which is a 2560-px monitor and not a fantasy.
    const index = nearestBucket(geometry.positions, at.x);
    if (index === null) return;
    setCursor(index);
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
    setCursor(Math.min(Math.max(from + (forward ? 1 : -1), 0), geometry.keys.length - 1));
  };

  return (
    <figure className={styles.figure} ref={frame}>
      <svg
        className={styles.chart}
        viewBox={`0 0 ${viewWidth} ${VIEW.height}`}
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
              x2={viewWidth - VIEW.pad.right}
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
          x2={viewWidth - VIEW.pad.right}
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
                  x2={viewWidth - VIEW.pad.right}
                  y1={hairY}
                  y2={hairY}
                  className={`${styles.hair}${fromBaseline ? ` ${styles.hairBaseline}` : ''}`}
                  data-testid="price-hair"
                  data-source={hairPrice.source}
                />
                <rect
                  x={priceTag.x}
                  y={priceTagY}
                  width={priceTag.width}
                  height={TAG.height}
                  rx={3}
                  className={`${styles.tag}${fromBaseline ? ` ${styles.tagBaseline}` : ''}`}
                  data-testid="price-tag-plate"
                  data-source={hairPrice.source}
                />
                <text
                  x={priceTag.textX}
                  y={priceTagY + TAG.baseline}
                  className={`${styles.tagText} ${ANCHOR[priceTag.anchor]}${
                    fromBaseline ? ` ${styles.tagTextBaseline}` : ''
                  }`}
                  data-testid="price-tag-text"
                  data-source={hairPrice.source}
                >
                  {formatMoney(hairPrice.value, currency)}
                </text>
                {/*
                  The dot where the two hairlines cross, so they meet on a mark
                  rather than in mid-air. Ours is the filled accent ring the
                  solid line already carries; the provider's is a hollow muted
                  one, smaller, matching the dash it sits on. Which is drawn
                  follows the plate rather than the data, because a period with
                  a median of ours reads that median whether or not the provider
                  reached it too — one crossing, one mark.
                */}
                {fromBaseline ? (
                  <circle
                    cx={hairX}
                    cy={hairY}
                    r={3.5}
                    className={styles.markerBaseline}
                    data-testid="baseline-marker"
                  />
                ) : (
                  <circle cx={hairX} cy={hairY} r={4.5} className={styles.marker} />
                )}
              </>
            )}

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
            {/*
              The figure the axis plate is showing is marked here rather than
              only in the plate's own ink, because that is where a reader looks
              to check what they just read off the axis. Both figures stay in
              the row whichever is on the axis: the plate is a readout of one
              of them, not a reason to hide the other.
            */}
            <span className={hairPrice?.source === 'ours' ? styles.onAxis : undefined}>
              median {reading.ours ? formatMoney(reading.ours.middle, currency) : NO_VALUE}
            </span>
            <span className={fromBaseline ? styles.onAxis : undefined}>
              baseline{' '}
              {reading.baseline === null ? NO_VALUE : formatMoney(reading.baseline, currency)}
            </span>
            {hairPrice === null ? null : (
              <span className={styles.axisNote} data-testid="axis-source">
                on the price axis: {AXIS_PRICE_WORDS[hairPrice.source]}
              </span>
            )}
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
        {reading === null
          ? ''
          : `${readingSentence(reading, currency)} ${axisPriceSentence(hairPrice, currency)}`.trim()}
      </p>

      {/*
        **Names, not sentences** — the same cut the departure chart's legend
        took, applied here because two charts in one panel reading as two
        different products is worse than either of them reading badly. Each
        entry is a mark and the two or three words that say which mark it is;
        the clause it used to print is its `title`, which is what a reader wants
        once they have found the line they were looking for and not before.
      */}
      <figcaption className={styles.legend}>
        <span className={styles.keyOurs} title={`Our observations — range and median per ${unit}`}>
          <i /> Our observations
        </span>
        <span className={styles.keyBaseline} title={axis.baselineMeaning}>
          <i /> {axis.baselineLegend}
        </span>
        {unsold.length > 0 ? (
          <span
            className={styles.keyUnsold}
            title="Nothing on sale — we asked and the board came back empty"
          >
            <i /> None on sale
          </span>
        ) : null}
        {/*
          The one absence with no glyph, said in words instead — 12.231. There
          is nothing in the archive that records a day we meant to look and did
          not, so there is no mark to draw for it; what says it is the axis,
          which is spaced by time and leaves a stretch nobody reached as wide as
          it really was. Shortened like the rest, and the words it keeps are the
          ones that distinguish it: this is not an absence we measured.
        */}
        <span
          className={styles.keyGap}
          title="A blank stretch is time nobody looked at — the axis is spaced by date"
        >
          <i /> Nobody looked
        </span>
      </figcaption>
    </figure>
  );
}
