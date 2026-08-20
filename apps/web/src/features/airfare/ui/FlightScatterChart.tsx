import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { boundsLabel, type Granularity } from '@/features/airfare/lib/buckets';
import {
  clampToTrack,
  marginForPrices,
  priceAxisTag,
  timeAxisTag,
  type TagAnchor,
} from '@/features/airfare/lib/crosshair';
import {
  absentDays,
  activeKey,
  axisDayLabel,
  axisTicks,
  cheapestPath,
  cheapestPerDay,
  dayBoundaries,
  departureDays,
  firstDayIn,
  flightName,
  flightPoints,
  flightSentence,
  nearestPlaced,
  periodKeys,
  placePoints,
  pointTimeLabel,
  priceAt,
  priceSpan,
  scatterWindow,
  stepKey,
  xOf,
  yOf,
  type PlacedPoint,
  type Plot,
  type WatchedRange,
} from '@/features/airfare/lib/flightScatter';
import { stopsLabel } from '@/features/airfare/lib/flightTable';
import { niceTicks } from '@/features/airfare/lib/scales';
import { formatDuration } from '@/features/airfare/lib/series';
import type { FareSnapshot } from '@/shared/api/fares';
import { formatMoney } from '@/shared/lib/money';

import styles from './FlightScatterChart.module.css';

/** The gap between the price plate and the plot, as on the price chart. */
const PRICE_GAP = 8;

/**
 * A plot taller than the price chart's, and since 12.232 a margin taller again.
 *
 * That chart draws one band; this one stacks twenty to thirty flights inside
 * every day, and at 260 a board spanning $180 to $420 puts four itineraries
 * inside the same three view units. The extra 40 buys about a sixth more
 * vertical separation for nothing but page height. The left padding is
 * `marginForPrices`, not a number — 12.62: it has to hold the widest fare
 * `formatMoney` can print, and a guess at it clipped the `S` off `S/4,580.00`.
 *
 * The last twenty-four units are all below the plot, and the plot itself is the
 * same size to the unit — the floor stays at 266 deliberately, so every dot on
 * this canvas is where it was. What they buy is the rail the empty departure
 * days are marked on, plus a row of its own for the day labels so the
 * crosshair's tag no longer covers them.
 */
const VIEW: Plot = {
  width: 760,
  height: 324,
  pad: { top: 14, right: 16, bottom: 58, left: marginForPrices(PRICE_GAP) },
};

const PLOT_BOTTOM = VIEW.height - VIEW.pad.bottom;
/** Where a departure date with no flight on it is marked, just under the plot floor. */
const RAIL_Y = PLOT_BOTTOM + 7;
const TAG = { height: 16, top: PLOT_BOTTOM + 16, baseline: 11.5 };
/** The day labels sit below the tag, on their own row. */
const AXIS_BASELINE = VIEW.height - 4;

/** The anchor as a class, never as an attribute — the reason is 12.62. */
const ANCHOR: Record<TagAnchor, string> = {
  start: styles.tagStart,
  middle: styles.tagMiddle,
  end: styles.tagEnd,
};

const UNIT: Record<Granularity, string> = { day: 'day', week: 'week', month: 'month' };

type FlightScatterChartProps = {
  snapshots: FareSnapshot[];
  granularity: Granularity;
  currency: string;
  /**
   * The departure day the reader is anchored on, held by the panel above —
   * 12.170. Null means "the earliest period that holds flights", which is
   * where a reader who has not stepped anywhere starts.
   */
  anchor: string | null;
  onAnchorChange: (day: string) => void;
  /**
   * The departure dates this route is a watch on — its month, or the one day
   * inside it the reader focused — 12.235.
   *
   * The frame is clipped to it, so a week straddling the end of the month draws
   * the days of the month it holds and not the four April dates the ISO week
   * also covers. Optional, because a chart handed no watch has nothing to clip
   * to and the calendar period is then the honest frame.
   */
  watched?: WatchedRange | null;
  label: string;
};

/**
 * The flights themselves, on a plane: one dot per itinerary, placed by when it
 * departs and what it costs, with a dashed line through the cheapest flight of
 * each day.
 *
 * **The near end of chart B's zoom — 12.203, superseding 12.140's separate
 * view.** `PriceBandChart` plots how one flight's price moved: what the
 * cheapest fare was on each day we looked, or the same fares by how far ahead
 * of the flight they were seen. This one plots departure time: which flight,
 * on which day of the watched month, at what hour. The first answers "is this
 * route cheaper than it was", the second "which departure do I book", and
 * collapsing *those* into one chart would still make both unreadable — the x
 * axis would have to mean two kinds of time at once. What did collapse is this
 * chart and the calendar curve, which were always the same question at two
 * scales: one watched month here, 331 departure dates there.
 *
 * The cloud is context and the dashed line is the shape. On a month there are
 * six to nine hundred dots, far more than anyone reads one at a time, and what
 * they are for is showing how tightly a day's board sits around its own
 * cheapest flight: a day where every itinerary is within twenty dollars is a
 * different day from one where the cheap flight is an 05:00 outlier under a
 * wall of $400s, and the line alone cannot tell them apart.
 *
 * SVG in the DOM rather than a canvas — 12.12, and measured rather than
 * assumed. Every dot stays a node a test can find; on a canvas the flight under
 * the pointer would be pixels.
 */
export function FlightScatterChart({
  snapshots,
  granularity,
  currency,
  anchor,
  onAnchorChange,
  watched = null,
  label,
}: FlightScatterChartProps) {
  /*
   * The anchor is a prop rather than state here — 12.170.
   *
   * It is still a departure day rather than an index into the periods, for
   * 12.143's reason: the granularity switch rebuilds the periods under it, and
   * an index kept across a week → day flip points at the seventh day of the
   * month rather than at the day being read. What changed is where it is kept.
   * Held here it died with this subtree, and the chart switch above unmounts
   * this subtree — so a reader who walked to the ninth departure, glanced at
   * the price history and came back was silently returned to the first. The
   * panel that owns the switch owns the period now.
   *
   * The crosshair stays state, because it is about this canvas and nothing
   * else: a pointer position on a chart that is not on screen is not a fact
   * worth keeping.
   */
  const [cursor, setCursor] = useState<number | null>(null);
  const help = useId();
  const status = useId();

  const days = useMemo(() => departureDays(snapshots), [snapshots]);
  const keys = useMemo(() => periodKeys(days, granularity), [days, granularity]);
  const key = activeKey(keys, granularity, anchor);
  const period = useMemo(
    () => (key === null ? null : scatterWindow(key, granularity, watched)),
    [key, granularity, watched],
  );

  const points = useMemo(
    () => (period === null ? [] : flightPoints(snapshots, period)),
    [snapshots, period],
  );
  const span = useMemo(() => priceSpan(points), [points]);
  const placed = useMemo(
    () => (period === null || span === null ? [] : placePoints(points, period, span, VIEW)),
    [points, period, span],
  );
  const line = useMemo(() => cheapestPerDay(points), [points]);
  const absent = useMemo(
    () => (period === null ? [] : absentDays(snapshots, period)),
    [snapshots, period],
  );

  /*
   * The cloud and the rings, held as elements rather than rebuilt each render.
   *
   * Measured, because this is the one place the dot count could have forced a
   * canvas. Every pointer move sets state, and rebuilt inline the 899 `<circle>`
   * elements are new objects each time, so React walks all of them: 16.9 to
   * 18.4 ms a move in jsdom, twenty times per test run. Memoised on the placed
   * points the element objects are identical across a crosshair-only render and
   * React skips the subtree outright — 4.3 to 6.1 ms a move, about three times
   * cheaper, on exactly the same DOM and the same nodes.
   *
   * That is what keeps 12.12: SVG at this size is not slow, *re-creating* it on
   * every pointer event is, and the fix is a `useMemo` rather than a rewrite
   * onto a surface where a flight stops being a node. Both figures are jsdom's,
   * which has no compositor and sets every attribute as a property — a browser
   * will do better than either, never worse.
   */
  const cloud = useMemo(
    () => (
      <g className={styles.dots} aria-hidden="true" data-testid="flight-dots">
        {placed.map((entry) => (
          <circle key={entry.point.key} cx={entry.x} cy={entry.y} r={2.6} />
        ))}
      </g>
    ),
    [placed],
  );

  const rings = useMemo(
    () => (
      <g className={styles.rings} aria-hidden="true" data-testid="cheapest-rings">
        {placed
          .filter((entry) => entry.point.cheapestOfDay)
          .map((entry) => (
            <circle key={entry.point.key} cx={entry.x} cy={entry.y} r={4.2} />
          ))}
      </g>
    ),
    [placed],
  );

  /*
   * The cursor resolved against the points that exist right now, for the reason
   * the price chart resolves its own: flipping the switch or stepping a period
   * rebuilds the array under an index kept from before. A stale index resolves
   * to nothing and the crosshair goes away, which is the honest outcome.
   */
  const active = cursor !== null && cursor >= 0 && cursor < placed.length ? cursor : null;
  const reading: PlacedPoint | null = active === null ? null : placed[active];

  if (period === null || span === null || placed.length === 0) {
    return (
      <p className={styles.empty}>
        No flights collected for this month yet. The first collection pass fills this plane — one
        dot per itinerary, on the day it departs.
      </p>
    );
  }

  const previous = stepKey(keys, period.key, -1);
  const next = stepKey(keys, period.key, 1);
  const ticks = axisTicks(period);
  const separators = dayBoundaries(period);
  /*
   * Round numbers inside the padded span, never four equal slices of it —
   * 12.233. `priceSpan` pads the board's own range by a twelfth so the dots at
   * the extremes are not clipped in half by the frame, and the four labels were
   * the padded ends and two points between them: money-formatted figures that
   * no itinerary on the canvas costs. The real extremes are in this chart's
   * accessible name, which takes them from the points themselves.
   */
  const priceTicks = niceTicks(span.low, span.high);
  const path = cheapestPath(points, period, span, VIEW);
  const prices = points.map((point) => point.price);
  // The window's own ends, not the calendar period's — 12.235. They are the
  // same thing except where a period overhangs the watched month, and there the
  // window is the half that only claims dates this route has been asked about.
  const caption = boundsLabel({ from: period.from, to: period.to });

  const hairPrice = reading === null ? 0 : priceAt(reading.y, span, VIEW);
  const priceTagY =
    reading === null ? 0 : clampToTrack(reading.y, TAG.height, VIEW.pad.top, PLOT_BOTTOM);
  const priceTag = priceAxisTag(VIEW.pad.left - PRICE_GAP, formatMoney(hairPrice, currency));
  const timeTag = timeAxisTag(
    reading === null ? 0 : reading.x,
    reading === null ? '' : pointTimeLabel(reading.point, period),
    VIEW.pad.left,
    VIEW.width - VIEW.pad.right,
  );

  const step = (direction: -1 | 1) => {
    const target = stepKey(keys, period.key, direction);
    if (target === null) return;
    const day = firstDayIn(days, target, granularity);
    if (day === null) return;
    onAnchorChange(day);
    setCursor(null);
  };

  /** Pointer position in the units the viewBox is drawn in, never in pixels. */
  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const x = ((event.clientX - box.left) / box.width) * VIEW.width;
    const y = ((event.clientY - box.top) / box.height) * VIEW.height;
    const index = nearestPlaced(placed, x, y);
    if (index !== null) setCursor(index);
  };

  const indexOf = (target: PlacedPoint['point']) =>
    placed.findIndex((entry) => entry.point === target);

  /*
   * Two axes for the keyboard, because the chart has two.
   *
   * Left and right walk the dashed line — the cheapest flight of each day — and
   * up and down walk that day's own board by price. Walking all nine hundred
   * dots in departure order was the other option and it is no way to cross a
   * month: nine hundred presses, most of them through flights twice the price
   * of the one beside them. The line is the shape the chart is for, and the
   * board under a day is the second question a reader has once they are on it.
   */
  const walk = (event: KeyboardEvent<SVGSVGElement>) => {
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    if (!horizontal && !vertical) return;
    // Otherwise the arrow scrolls the page out from under the chart being read.
    event.preventDefault();

    if (horizontal) {
      const forward = event.key === 'ArrowRight';
      if (reading === null) {
        // Arriving from nothing, the first press lands on the end the reader is
        // moving away from: right starts at the earliest day, left at the last.
        const first = forward ? line[0] : line.at(-1);
        if (first) setCursor(indexOf(first));
        return;
      }
      const at = line.findIndex((point) => point.day === reading.point.day);
      const target = line[Math.min(Math.max(at + (forward ? 1 : -1), 0), line.length - 1)];
      if (target) setCursor(indexOf(target));
      return;
    }

    if (reading === null) return;
    const board = placed
      .filter((entry) => entry.point.day === reading.point.day)
      .sort((a, b) => a.point.price - b.point.price);
    const at = board.findIndex((entry) => entry.point === reading.point);
    // Up the chart is dearer, which is the direction the price axis runs.
    const to = Math.min(Math.max(at + (event.key === 'ArrowUp' ? 1 : -1), 0), board.length - 1);
    if (board[to]) setCursor(indexOf(board[to].point));
  };

  return (
    <figure className={styles.figure}>
      <div className={styles.head}>
        <p className={styles.window}>
          <strong>
            {placed.length} flight{placed.length === 1 ? '' : 's'}
          </strong>{' '}
          departing {caption}
        </p>
        {/*
          One step per period that has flights, rather than per calendar unit: a
          week with nothing collected in it is an empty chart with working
          arrows, which is a worse answer than skipping it. Absent on a month,
          where a watched route has exactly one.
        */}
        {keys.length > 1 ? (
          <div className={styles.steps}>
            <button
              type="button"
              onClick={() => step(-1)}
              disabled={previous === null}
              aria-label={`Previous ${UNIT[granularity]} with flights`}
            >
              &lsaquo;
            </button>
            <span>
              {keys.indexOf(period.key) + 1} / {keys.length}
            </span>
            <button
              type="button"
              onClick={() => step(1)}
              disabled={next === null}
              aria-label={`Next ${UNIT[granularity]} with flights`}
            >
              &rsaquo;
            </button>
          </div>
        ) : null}
      </div>

      <svg
        className={styles.chart}
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        role="img"
        tabIndex={0}
        aria-label={`${label}. ${placed.length} itineraries departing ${caption}, from ${formatMoney(Math.min(...prices), currency)} to ${formatMoney(Math.max(...prices), currency)}.`}
        aria-describedby={`${help} ${status}`}
        onPointerMove={trackPointer}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={walk}
        onBlur={() => setCursor(null)}
      >
        {priceTicks.map((value) => (
          <g key={value}>
            <line
              x1={VIEW.pad.left}
              x2={VIEW.width - VIEW.pad.right}
              y1={yOf(value, span, VIEW)}
              y2={yOf(value, span, VIEW)}
              className={styles.grid}
            />
            <text
              x={VIEW.pad.left - PRICE_GAP}
              y={yOf(value, span, VIEW) + 4}
              className={`${styles.axis} ${styles.tagEnd}`}
            >
              {formatMoney(value, currency)}
            </text>
          </g>
        ))}

        {/* A midnight between two days, so the cloud reads as days and not as a smear. */}
        {separators.map((offset) => (
          <line
            key={offset}
            x1={xOf(offset, period, VIEW)}
            x2={xOf(offset, period, VIEW)}
            y1={VIEW.pad.top}
            y2={PLOT_BOTTOM}
            className={styles.separator}
            aria-hidden="true"
          />
        ))}

        {/* The floor the absence marks hang under, so the rail is a place. */}
        <line
          x1={VIEW.pad.left}
          x2={VIEW.width - VIEW.pad.right}
          y1={PLOT_BOTTOM}
          y2={PLOT_BOTTOM}
          className={styles.floor}
        />

        {ticks.map((tick) => (
          <text
            key={tick.offset}
            x={xOf(tick.offset, period, VIEW)}
            y={AXIS_BASELINE}
            className={`${styles.axis} ${styles.tagMiddle}`}
          >
            {tick.label}
          </text>
        ))}

        {/*
          A departure date inside the frame with no flight on it, and which kind
          of nothing it is — 12.232. The dashed line stops at one of these
          rather than reaching over it (12.230), so without a mark the reader is
          left with a break and no reason for it. Under the plot floor for the
          horizon chart's reason: a mark inside the plot at any height reads as
          a fare, and "no flights" is the one thing that must not be drawn as
          one.
        */}
        {absent.map((day) => (
          <g
            key={day.day}
            className={styles.hole}
            data-testid={day.answered ? 'day-unsold' : 'day-unanswered'}
          >
            <title>
              {axisDayLabel(day.day)}:{' '}
              {day.answered ? 'nothing on sale — the board came back empty' : 'never collected'}
            </title>
            {day.answered ? (
              <rect
                x={xOf(day.offset, period, VIEW) - 1.6}
                y={RAIL_Y - 1.6}
                width={3.2}
                height={3.2}
                className={styles.unsold}
              />
            ) : (
              <circle
                cx={xOf(day.offset, period, VIEW)}
                cy={RAIL_Y}
                r={2}
                className={styles.unanswered}
              />
            )}
          </g>
        ))}

        {path ? <path d={path} className={styles.cheapest} aria-hidden="true" /> : null}

        {/*
          The dots. No `<title>` on each of them: at month scale that is nine
          hundred more nodes for a native tooltip that waits a second to appear
          and then fights the crosshair, which says the same thing immediately.
          Every flight is named in the readout below and listed in full in the
          table under this panel.
        */}
        {cloud}

        {/*
          A ring on the cheapest flight of each day, so the day view — where a
          line through one node draws nothing — still says which flight it is.
        */}
        {rings}

        {reading ? (
          <g className={styles.crosshair} aria-hidden="true" data-testid="scatter-crosshair">
            <line
              x1={reading.x}
              x2={reading.x}
              y1={VIEW.pad.top}
              y2={RAIL_Y + 5}
              className={styles.hair}
            />
            <line
              x1={VIEW.pad.left}
              x2={VIEW.width - VIEW.pad.right}
              y1={reading.y}
              y2={reading.y}
              className={styles.hair}
            />
            <circle cx={reading.x} cy={reading.y} r={5} className={styles.marker} />

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
              data-testid="scatter-price-tag"
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
            />
            <text
              x={timeTag.textX}
              y={TAG.top + TAG.baseline}
              className={`${styles.tagText} ${ANCHOR[timeTag.anchor]}`}
              data-testid="scatter-time-tag"
            >
              {pointTimeLabel(reading.point, period)}
            </text>
          </g>
        ) : null}
      </svg>

      {/* Fixed height whether or not a flight is under the pointer, so the table below never jumps. */}
      <p className={styles.readout} aria-hidden="true">
        {reading === null ? (
          <span className={styles.hint}>
            Point at a flight, or use the arrow keys — left and right walk the cheapest flight of
            each day, up and down that day&rsquo;s board.
          </span>
        ) : (
          <>
            <strong>{flightName(reading.point)}</strong>
            <span className={styles.muted}>
              {reading.point.airlineName ?? reading.point.airline}
            </span>
            <span>{pointTimeLabel(reading.point, period)}</span>
            <span className={styles.muted}>{stopsLabel(reading.point.transfers)}</span>
            <span className={styles.muted}>{formatDuration(reading.point.durationMinutes)}</span>
            <strong>{formatMoney(reading.point.price, currency)}</strong>
            {reading.point.cheapestOfDay ? (
              <span className={styles.flag}>cheapest of the day</span>
            ) : null}
          </>
        )}
      </p>

      <p id={help} className={styles.srOnly}>
        Left and right arrow keys move between the cheapest flight of each day; up and down move
        through that day&rsquo;s board by price.
      </p>
      <p id={status} className={styles.srOnly} role="status">
        {reading === null ? '' : flightSentence(reading.point, currency)}
      </p>

      <figcaption className={styles.legend}>
        <span className={styles.keyDot}>
          <i /> One dot is one itinerary, on the day it departs
        </span>
        <span className={styles.keyLine}>
          <i /> The cheapest flight of each day — broken where a day has none
        </span>
        {absent.some((day) => day.answered) ? (
          <span className={styles.keyUnsold}>
            <i /> Nothing on sale — we asked and the board came back empty
          </span>
        ) : null}
        {absent.some((day) => !day.answered) ? (
          <span className={styles.keyUnanswered}>
            <i /> Never collected — we have no reading either way
          </span>
        ) : null}
      </figcaption>
    </figure>
  );
}
