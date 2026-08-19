import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { formatFlightDate } from '@/features/airfare/data/fareRoutes';
import {
  contiguousRuns,
  spanOf,
  type Bucket,
  type Granularity,
} from '@/features/airfare/lib/buckets';
import {
  absenceNote,
  calendarPeriods,
  calendarReading,
  calendarBuckets,
  calendarKeys,
  calendarSentence,
  collectedAtLabel,
  rangeRepeatsLabel,
  type CalendarPeriod,
} from '@/features/airfare/lib/calendarCurve';
import {
  clampToTrack,
  marginForPrices,
  nearestBucket,
  priceAxisTag,
  timeAxisTag,
  type TagAnchor,
} from '@/features/airfare/lib/crosshair';
import { NO_VALUE, formatMoney } from '@/shared/lib/money';
import type { CalendarCurve } from '@/shared/api/fares';

import styles from './CalendarCurveChart.module.css';

/** The gap between the price plate and the plot it labels — `PriceBandChart`'s. */
const PRICE_GAP = 8;

/*
 * Taller in the bottom margin than the history chart, and the extra 24 units
 * buy two things that chart does not need. One is the rail the holes are marked
 * on, which cannot sit inside the plot without a "no fare on sale" reading as
 * the cheapest fare on the board. The other is that the two end labels keep
 * their own row below the crosshair's tag instead of being covered by it: on
 * this chart those two labels *are* the statement of the domain — the first and
 * last departure date the curve priced — and hiding them under a moving plate
 * would hide the one thing the axis has to say.
 */
const VIEW = {
  width: 760,
  height: 284,
  pad: { top: 14, right: 16, bottom: 48, left: marginForPrices(PRICE_GAP) },
};

const PLOT_BOTTOM = VIEW.height - VIEW.pad.bottom;
/** Where a period holding no price is marked, just under the plot floor. */
const RAIL_Y = PLOT_BOTTOM + 7;
const TAG = { height: 16, top: PLOT_BOTTOM + 16, baseline: 11.5 };
/** The two end labels sit below the tag, on their own row. */
const AXIS_BASELINE = VIEW.height - 4;

/**
 * How much track a dot needs before it reads as a dot rather than as thickness.
 *
 * Measured against the radius: at 3 units a marker needs roughly its own
 * diameter of clear track either side. 331 departure dates across 660 units is
 * two units apart, so a dot per date would draw a six-unit-wide caterpillar and
 * call it a series — the line already carries that shape, and better. At a week
 * the spacing is 14 units and at a month 60, where the dots are what let a
 * reader point at one. So this is spacing arithmetic rather than a granularity
 * table, and it stays right if the horizon ever changes length.
 */
const DOT_MIN_SPACING = 8;

/** The anchor as a class, never as an attribute — `PriceBandChart` explains why. */
const ANCHOR: Record<TagAnchor, string> = {
  start: styles.tagStart,
  middle: styles.tagMiddle,
  end: styles.tagEnd,
};

type CalendarCurveChartProps = {
  curve: CalendarCurve | null;
  granularity: Granularity;
  label: string;
  /** True while the request is in flight, so "never collected" is not claimed early. */
  loading?: boolean;
};

type Cursor = { index: number; y: number | null };

/** The unit word for the current switch position, in departure terms. */
function unitWord(granularity: Granularity): string {
  if (granularity === 'week') return 'week';
  if (granularity === 'month') return 'month';
  return 'departure date';
}

/**
 * What every departure date out to the horizon costs, drawn as one curve.
 *
 * **The horizontal axis is which departure date, and it is a fourth meaning of
 * time on this page.** The history chart's x is when we looked; the lead-time
 * view's is how long before the flight we looked; the scatter's is when the
 * plane leaves inside one period; this one is which day you would fly, across
 * the whole booking horizon at once. None folds into another, so the figure
 * says which it is in words rather than leaving it to the tick labels.
 *
 * It is **not** a fourth `BucketAxis` on `PriceBandChart`, and that was checked
 * against that component rather than assumed. It builds its keys from the union
 * of the two series it is handed, so a departure date carrying no price is not
 * on the axis at all and the gap closes up — the spacing stops being a
 * calendar, which is the one property this chart exists to have. It also has no
 * second series to put behind a curve that has no baseline, nowhere to tell two
 * kinds of absence apart, and a `<title>` per bucket, which is 331 of them
 * here. The arithmetic is shared instead: `summarise` builds the bands,
 * `spanOf` scales them, `contiguousRuns` splits them, and `lib/crosshair.ts`
 * places every tag.
 *
 * The domain is the curve's own `fromDate`..`toDate` and never today's clock.
 * A row states the window it asked about, and a curve collected yesterday must
 * draw the eleven months it actually priced rather than sliding a day forward
 * every midnight.
 *
 * **There are no previous/next arrows.** The scatter has them because it draws
 * one period at a time out of a month and something has to step between them;
 * this draws the entire horizon in one frame, so an arrow would have nothing to
 * step to. The switch above still means something — it decides whether a point
 * is one date, a week of them or a month of them — but there is no second page
 * to reach. The arrow keys move the crosshair, which is the only stepping this
 * chart has.
 *
 * SVG, decision 12.12, and for the extra reason that the crosshair's numbers
 * are figures a reader may want read out rather than pixels.
 */
export function CalendarCurveChart({
  curve,
  granularity,
  label,
  loading = false,
}: CalendarCurveChartProps) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const help = useId();
  const status = useId();

  const periods = useMemo(() => calendarPeriods(curve, granularity), [curve, granularity]);
  /*
   * The axis and the series, kept apart on purpose.
   *
   * `keys` is every period between the two ends of the window, holes included,
   * because that is what makes the axis a calendar. `priced` is the subset that
   * carries a figure, and it is an ordinary `Bucket[]` — the same shape the
   * other charts are drawn from — so `spanOf` scales this one and
   * `contiguousRuns` splits it exactly as it splits theirs.
   */
  const keys = useMemo(() => calendarKeys(periods), [periods]);
  const priced = useMemo(() => calendarBuckets(periods), [periods]);
  const span = useMemo(() => spanOf(priced), [priced]);

  const geometry = useMemo(() => {
    if (span === null || periods.length === 0) return null;
    // Never anchored at zero, for `PriceBandChart`'s reason: a horizon that
    // runs 41 to 196 says something, and a zero-based axis flattens it.
    const padding = Math.max((span.high - span.low) * 0.12, span.high * 0.02, 1);
    const low = Math.max(0, span.low - padding);
    const high = span.high + padding;

    const inner = {
      width: VIEW.width - VIEW.pad.left - VIEW.pad.right,
      height: PLOT_BOTTOM - VIEW.pad.top,
    };
    /*
     * By index across every period, holes included. Dropping an empty period
     * would close its gap and slide every later departure leftwards onto a day
     * it does not belong to — the axis would stop being a calendar.
     */
    const x = (index: number) =>
      VIEW.pad.left +
      (periods.length === 1 ? inner.width / 2 : (index / (periods.length - 1)) * inner.width);
    const rank = new Map(keys.map((key, index) => [key, index]));
    const y = (value: number) =>
      VIEW.pad.top + (1 - (value - low) / (high - low || 1)) * inner.height;
    const priceAt = (position: number) => {
      const ratio = 1 - (position - VIEW.pad.top) / (inner.height || 1);
      return low + Math.min(Math.max(ratio, 0), 1) * (high - low);
    };

    /*
     * The curve, in runs of periods that are neighbours on the axis.
     *
     * `contiguousRuns` unchanged, and this is the same claim it was written to
     * refuse: one path across a hole says the fare moved evenly through a
     * stretch nobody has a figure for. Here the hole is a departure date with
     * nothing on sale, or one nobody ever got an answer for, and a line drawn
     * across either quotes a fare that was never quoted — worse than a gap for
     * looking like data.
     *
     * The `keys` handed in are **every** period in the window rather than only
     * the priced ones, and that is the difference from the other two charts: on
     * theirs a period neither series reached is not on the axis at all and so
     * cannot make a hole, while here it must, or the calendar closes up.
     *
     * A run of one has no line to draw and is remembered for a dot instead, or
     * a priced date between two empty ones would vanish.
     */
    const runs = contiguousRuns(keys, priced);
    const at = (key: string) => x(rank.get(key)!);

    const draw = (run: Bucket[], pick: (bucket: Bucket) => number) =>
      run
        .map(
          (bucket, index) =>
            `${index ? 'L' : 'M'}${at(bucket.key).toFixed(1)},${y(pick(bucket)).toFixed(1)}`,
        )
        .join('');

    const middle = runs
      .filter((run) => run.length > 1)
      .map((run) => draw(run, (bucket) => bucket.middle))
      .join('');

    // A ribbon only where a period can hold a spread at all. At `day` a period
    // is one departure date and one price, so low, high and middle are the same
    // number and the ribbon would be a zero-height polygon over 331 points.
    const hasSpread = priced.some((bucket) => bucket.high > bucket.low);
    const band = hasSpread
      ? runs
          .filter((run) => run.length > 1)
          .map(
            (run) =>
              draw(run, (bucket) => bucket.high) +
              [...run]
                .reverse()
                .map((bucket) => `L${at(bucket.key).toFixed(1)},${y(bucket.low).toFixed(1)}`)
                .join('') +
              'Z',
          )
          .join('')
      : '';

    const spacing = periods.length > 1 ? inner.width / (periods.length - 1) : inner.width;
    const lonely = new Set(
      runs.filter((run) => run.length === 1).map((run) => rank.get(run[0].key)!),
    );

    return {
      x,
      y,
      priceAt,
      low,
      high,
      positions: periods.map((_, index) => x(index)),
      middle,
      band,
      /** Every priced period gets a dot only where there is room for one. */
      dotted: spacing >= DOT_MIN_SPACING,
      lonely,
      ticks: [low, (low + high) / 2, high],
    };
    // `keys` and `priced` are both derived from `periods` and change with it,
    // so naming them is redundant rather than load-bearing — but a dependency
    // list that leaves out a value the body reads is one nobody can check at a
    // glance, and the rule is right that it should not have to be reasoned about.
  }, [span, periods, keys, priced]);

  const currency = curve?.currency ?? 'USD';

  /*
   * The crosshair against the geometry that exists now. An index kept from
   * before the switch moved would point past the end of a shorter array, and
   * resolving to nothing is the honest outcome — 331 days do not become 48
   * weeks at the same index.
   */
  const active =
    geometry && cursor !== null && cursor.index >= 0 && cursor.index < periods.length
      ? cursor.index
      : null;
  const reading = active === null ? null : calendarReading(periods[active]);

  /*
   * The marks and dots, memoised as elements. A pointer move rebuilds this
   * component many times a second and none of those rebuilds change what is
   * drawn underneath the crosshair — only the crosshair itself moves.
   */
  const marks = useMemo(() => {
    if (!geometry) return null;
    return periods.map((period, index) =>
      period.bucket === null ? (
        <HoleMark key={period.key} period={period} x={geometry.x(index)} />
      ) : null,
    );
  }, [geometry, periods]);

  const dots = useMemo(() => {
    if (!geometry) return null;
    return periods.map((period, index) => {
      const bucket = period.bucket;
      if (bucket === null) return null;
      if (!geometry.dotted && !geometry.lonely.has(index)) return null;
      return (
        <g key={period.key} className={styles.point}>
          <title>
            {period.label}: {formatMoney(bucket.middle, currency)}
            {bucket.count > 1
              ? ` median, ${formatMoney(bucket.low, currency)}–${formatMoney(bucket.high, currency)} across ${bucket.count} departure dates`
              : ''}
          </title>
          <circle cx={geometry.x(index)} cy={geometry.y(bucket.middle)} r={3} />
        </g>
      );
    });
  }, [geometry, periods, currency]);

  if (curve === null) {
    return (
      <p className={styles.empty}>
        {loading
          ? 'Reading the booking horizon…'
          : 'No booking horizon collected for this route yet. A collection pass prices every departure date out to the provider’s own limit — two requests for eleven months.'}
      </p>
    );
  }

  if (geometry === null) {
    // The curve exists and priced nothing at all. Naming the two absences is
    // the whole content of this branch: a horizon of unsold days is a fact
    // about the route, a horizon of unanswered days is a fact about us.
    const total = periods.reduce(
      (sum, period) => ({
        unsold: sum.unsold + period.unsold,
        unanswered: sum.unanswered + period.unanswered,
      }),
      { unsold: 0, unanswered: 0 },
    );
    return (
      <p className={styles.empty}>
        The horizon from {formatFlightDate(curve.fromDate)} to {formatFlightDate(curve.toDate)}{' '}
        carries no fare at all — {total.unsold} day{total.unsold === 1 ? '' : 's'} with nothing on
        sale and {total.unanswered} never answered for.
      </p>
    );
  }

  const unit = unitWord(granularity);
  // Departure dates with a figure, not periods with one: at a week or a month
  // one drawn point stands for several days, and the accessible name is a claim
  // about how much of the horizon is actually priced.
  const datesPriced = priced.reduce((sum, bucket) => sum + bucket.count, 0);

  const hairX = active === null ? 0 : geometry.positions[active];
  const hairY =
    reading === null
      ? 0
      : (cursor?.y ??
        (reading.band
          ? geometry.y(reading.band.middle)
          : VIEW.pad.top + (PLOT_BOTTOM - VIEW.pad.top) / 2));
  const hairPrice = geometry.priceAt(hairY);
  const priceTagY = clampToTrack(hairY, TAG.height, VIEW.pad.top, PLOT_BOTTOM);
  const priceTag = priceAxisTag(VIEW.pad.left - PRICE_GAP, formatMoney(hairPrice, currency));
  const timeTag = timeAxisTag(
    hairX,
    reading?.label ?? '',
    VIEW.pad.left,
    VIEW.width - VIEW.pad.right,
  );

  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const x = ((event.clientX - box.left) / box.width) * VIEW.width;
    const y = ((event.clientY - box.top) / box.height) * VIEW.height;
    /*
     * `nearestBucket` unchanged, and this is the chart it was written for. The
     * scatter had to snap in two dimensions because twenty itineraries share a
     * departure day and two share a minute, so an x alone could not name one. A
     * calendar curve is genuinely one-dimensional — one price per departure
     * date, no two periods at the same x — so nearest-along-x *is* the answer,
     * and a second snap here would be a reimplementation of nothing.
     */
    const index = nearestBucket(geometry.positions, x);
    if (index === null) return;
    setCursor({ index, y });
  };

  const step = (event: KeyboardEvent<SVGSVGElement>) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const forward = event.key === 'ArrowRight';
    const from = active ?? (forward ? -1 : periods.length);
    setCursor({
      index: Math.min(Math.max(from + (forward ? 1 : -1), 0), periods.length - 1),
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
        aria-label={`${label}. ${datesPriced} departure date${datesPriced === 1 ? '' : 's'} priced between ${formatFlightDate(curve.fromDate)} and ${formatFlightDate(curve.toDate)}, from ${formatMoney(span!.low, currency)} to ${formatMoney(span!.high, currency)}.`}
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

        {/* The floor the hole marks hang under, so the rail is a place and not a row of loose glyphs. */}
        <line
          x1={VIEW.pad.left}
          x2={VIEW.width - VIEW.pad.right}
          y1={PLOT_BOTTOM}
          y2={PLOT_BOTTOM}
          className={styles.floor}
        />

        {geometry.band ? (
          <path d={geometry.band} className={styles.band} aria-hidden="true" />
        ) : null}
        {geometry.middle ? (
          <path d={geometry.middle} className={styles.curve} aria-hidden="true" />
        ) : null}

        {dots}
        {marks}

        {/*
          Both ends of the departure axis, written out. These two labels are the
          domain: they say the curve runs from this departure date to that one,
          which is the fact a reader has to have before any point on it means
          anything.
        */}
        <text
          x={VIEW.pad.left}
          y={AXIS_BASELINE}
          className={`${styles.axis} ${styles.tagStart}`}
          data-testid="axis-from"
        >
          {formatFlightDate(curve.fromDate)}
        </text>
        <text
          x={VIEW.width - VIEW.pad.right}
          y={AXIS_BASELINE}
          className={`${styles.axis} ${styles.tagEnd}`}
          data-testid="axis-to"
        >
          {formatFlightDate(curve.toDate)}
        </text>

        {reading ? (
          <g className={styles.crosshair} aria-hidden="true" data-testid="crosshair">
            <line x1={hairX} x2={hairX} y1={VIEW.pad.top} y2={RAIL_Y + 5} className={styles.hair} />
            <line
              x1={VIEW.pad.left}
              x2={VIEW.width - VIEW.pad.right}
              y1={hairY}
              y2={hairY}
              className={styles.hair}
            />
            {reading.band ? (
              <circle
                cx={hairX}
                cy={geometry.y(reading.band.middle)}
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

      <p className={styles.readout} aria-hidden="true">
        {reading === null ? (
          <span className={styles.hint}>
            Point at the chart, or press the arrow keys, to read a {unit}.
          </span>
        ) : (
          <>
            <strong>{reading.label}</strong>
            {rangeRepeatsLabel(reading) ? null : (
              <span className={styles.period}>{reading.range}</span>
            )}
            <span>
              {reading.band === null
                ? NO_VALUE
                : reading.priced === 1
                  ? formatMoney(reading.band.middle, currency)
                  : `${formatMoney(reading.band.low, currency)}–${formatMoney(reading.band.high, currency)}`}
            </span>
            {reading.band !== null && reading.priced > 1 ? (
              <span>median {formatMoney(reading.band.middle, currency)}</span>
            ) : null}
            {absenceNote(reading) ? (
              <span className={styles.absence}>{absenceNote(reading)}</span>
            ) : null}
          </>
        )}
      </p>

      <p id={help} className={styles.srOnly}>
        Left and right arrow keys move the crosshair one {unit} at a time and read out what that
        departure costs. The whole booking horizon is drawn at once, so there is no next or previous
        period to step to.
      </p>
      <p id={status} className={styles.srOnly} role="status">
        {reading === null ? '' : calendarSentence(reading, currency)}
      </p>

      {/*
        The axes in words. The reader asked for this specifically, and the page
        has earned it: since 12.170 there are three other charts here and every
        one of their x axes is made of time. Working out which is which from the
        tick labels is exactly the mistake this sentence forecloses, and it
        names all four rather than the two that existed when it was written.
      */}
      <figcaption className={styles.legend}>
        <p className={styles.axesNote}>
          <strong>Horizontal — which departure date:</strong> every day from{' '}
          {formatFlightDate(curve.fromDate)} to {formatFlightDate(curve.toDate)}, the whole booking
          horizon at once. <strong>Vertical — the cheapest fare for that departure date</strong>, in{' '}
          {currency}. Not the same axis as the charts beside it: price history plots{' '}
          <em>when we looked</em>, lead time plots <em>how long before the flight we looked</em>,
          flights plots <em>when the plane leaves</em>, this plots <em>which day you fly</em>.
        </p>
        <span className={styles.keys}>
          <span className={styles.keyCurve}>
            <i /> Cheapest fare per {unit}
          </span>
          {geometry.band ? (
            <span className={styles.keyBand}>
              <i /> Cheapest to dearest departure date inside the {unit}
            </span>
          ) : null}
          <span className={styles.keyUnsold}>
            <i /> Nothing on sale — the provider answered and had none
          </span>
          <span className={styles.keyUnanswered}>
            <i /> Never answered for — we have no reading either way
          </span>
        </span>
        <p className={styles.collected}>
          Collected {collectedAtLabel(curve.capturedAt)} from {curve.source}. {periods.length}{' '}
          {unit}
          {periods.length === 1 ? '' : 's'} drawn.
        </p>
      </figcaption>
    </figure>
  );
}

/**
 * A period holding no price, marked so the two reasons cannot be read as one.
 *
 * A filled square is an answer — the provider was asked and had nothing to
 * sell. A hollow ring is the absence of one. That is the difference 12.154 goes
 * to the trouble of storing, and a chart that drew them alike, or drew neither,
 * would throw it away at the last step. Both sit under the plot floor rather
 * than on it, because a mark inside the plot at any height is a price.
 *
 * A week or a month can hold both kinds at once, and it draws as the ring: an
 * unanswered day is the weaker claim of the two, and a period part of which we
 * never read cannot honestly be marked "asked, and there were none". The title
 * and the crosshair's read-out carry both counts, which is where the detail
 * belongs — a glyph two units wide cannot say two things.
 */
function HoleMark({ period, x }: { period: CalendarPeriod; x: number }) {
  const unsoldOnly = period.unanswered === 0;
  const note = absenceNote(calendarReading(period)) ?? 'no fare';
  return (
    <g className={styles.hole} data-testid={unsoldOnly ? 'hole-unsold' : 'hole-unanswered'}>
      <title>
        {period.label}: {note}
      </title>
      {unsoldOnly ? (
        <rect x={x - 1.6} y={RAIL_Y - 1.6} width={3.2} height={3.2} className={styles.unsold} />
      ) : (
        <circle cx={x} cy={RAIL_Y} r={2} className={styles.unanswered} />
      )}
    </g>
  );
}
