import { useId, useMemo, useState, type KeyboardEvent, type PointerEvent } from 'react';

import { formatFlightDate } from '@/features/airfare/data/fareRoutes';
import { boundsLabel, type Granularity } from '@/features/airfare/lib/buckets';
import { collectedAtLabel } from '@/features/airfare/lib/calendarCurve';
import {
  clampToTrack,
  marginForPrices,
  priceAxisTag,
  timeAxisTag,
  type TagAnchor,
} from '@/features/airfare/lib/crosshair';
import {
  curveMarks,
  frameDays,
  frameSource,
  isWatched,
  sourceRuns,
  sourceSeams,
  type CurveMark,
  type FrameDay,
  type FrameSource,
} from '@/features/airfare/lib/departureFrame';
import {
  absentDays,
  axisDayLabel,
  axisTicks,
  cheapestPath,
  cheapestPerDay,
  dayBoundaries,
  flightName,
  flightPoints,
  flightSentence,
  nearestPlaced,
  offsetAt,
  placePoints,
  pointTimeLabel,
  scatterWindow,
  spanOfPrices,
  xOf,
  yOf,
  type PlacedPoint,
  type Plot,
  type ScatterPoint,
  type ScatterSpan,
  type ScatterWindow,
  type WatchedRange,
} from '@/features/airfare/lib/flightScatter';
import { stopsLabel } from '@/features/airfare/lib/flightTable';
import { niceTicks } from '@/features/airfare/lib/scales';
import { formatDuration } from '@/features/airfare/lib/series';
import type { CalendarCurve, FareSnapshot } from '@/shared/api/fares';
import { formatMoney } from '@/shared/lib/money';

import styles from './DepartureChart.module.css';

/** The gap between the price plate and the plot, as on the price chart. */
const PRICE_GAP = 8;

const MINUTES_PER_DAY = 1440;

/**
 * Fourteen units taller in the bottom margin than the scatter this replaces,
 * and the plot floor has not moved by a unit.
 *
 * The extra row is the source rail: which archive answered for which stretch of
 * the frame, written under the dates it covers. It is drawn on every frame
 * rather than only on the mixed ones, because a row that appeared when a week
 * crossed the end of the month would move everything below it exactly when the
 * reader was trying to read the boundary.
 */
const VIEW: Plot = {
  width: 760,
  height: 338,
  pad: { top: 14, right: 16, bottom: 72, left: marginForPrices(PRICE_GAP) },
};

const PLOT_BOTTOM = VIEW.height - VIEW.pad.bottom;
/** Where a departure date with no answer of any kind is marked, under the plot floor. */
const RAIL_Y = PLOT_BOTTOM + 7;
const TAG = { height: 16, top: PLOT_BOTTOM + 16, baseline: 11.5 };
/** The date labels sit below the tag, on their own row. */
const AXIS_BASELINE = 311;
/** And the source rail below them, so the two never overprint. */
const SOURCE_BASELINE = 327;

/** The anchor as a class, never as an attribute — the reason is 12.62. */
const ANCHOR: Record<TagAnchor, string> = {
  start: styles.tagStart,
  middle: styles.tagMiddle,
  end: styles.tagEnd,
};

const UNIT: Record<Granularity, string> = { day: 'day', week: 'week', month: 'month' };

/** What each stretch of the frame is drawn from, in the fewest words that are true. */
const SOURCE_WORDS: Record<'board' | 'curve', string> = {
  board: 'every flight, at the hour it departs',
  curve: 'one price a date',
};

type DepartureChartProps = {
  snapshots: FareSnapshot[];
  /** The booking horizon as last collected, or null where there is none yet. */
  curve: CalendarCurve | null;
  /** The departure dates the boards cover — the watched month, or one day of it. */
  watched: WatchedRange | null;
  granularity: Granularity;
  currency: string;
  /** The period on screen, resolved by the panel that owns the anchor — 12.170. */
  periodKey: string | null;
  /** Every period the reader can step to, for the counter beside the arrows. */
  keys: string[];
  onStep: (direction: -1 | 1) => void;
  label: string;
  /** True while the horizon request is in flight, so "never collected" is not claimed early. */
  horizonLoading?: boolean;
  /** Why the horizon could not be read, where the request itself failed — 12.237. */
  horizonError?: Error | null;
};

/** Where the crosshair is: on one itinerary, or on one whole departure date. */
type Reading =
  { kind: 'flight'; placed: PlacedPoint } | { kind: 'curve'; mark: CurveMark; index: number };

/**
 * What each departure date costs, drawn from whichever archive can answer for
 * it — one dot per itinerary inside the watched month, one span per date
 * outside it.
 *
 * **The source is chosen by the date and not by a control.** This chart and the
 * horizon curve used to be the two ends of a zoom the reader worked themselves,
 * which meant the reader had to know which archive held which dates before they
 * could pick the right end. They do not: what they know is the departure date
 * they are looking at. So the zoom is gone and the frame asks the question per
 * day — inside the watched month the boards answer, outside it the calendar
 * curve does, and a week straddling the boundary is answered by both in one
 * frame.
 *
 * **The axis changes resolution where the source does, and the seam is drawn.**
 * A board day is 1,440 minutes of clock and every itinerary sits at its own
 * departure time. A curve date has no time of day at all — it is one price for
 * a whole date — so it is drawn as a span across the date rather than as a
 * point inside it, and the vertical rule at the boundary is where the axis
 * stops being a clock. Placing a curve date at midnight or at noon was the
 * alternative and both invent a departure time, which is the class of claim
 * this panel has spent two releases deleting.
 *
 * **Day never reaches the curve.** Its periods are the departure dates the
 * boards hold, so there is no way to arrive at a 24-hour clock carrying a
 * single timeless number. Month cannot mix either — a calendar month is the
 * watched one or it is not. Week is the only view where both resolutions are on
 * screen at once, which is why the seam is built for it.
 *
 * SVG in the DOM rather than a canvas — 12.12. Every itinerary stays a node a
 * test can find and a screen reader can reach.
 */
export function DepartureChart({
  snapshots,
  curve,
  watched,
  granularity,
  currency,
  periodKey,
  keys,
  onStep,
  label,
  horizonLoading = false,
  horizonError = null,
}: DepartureChartProps) {
  /*
   * The crosshair is this canvas's own state and the period is not — 12.170.
   * A pointer position on a chart that is not on screen is not a fact worth
   * keeping; the period the reader walked to is, and it lives in the panel.
   */
  const [cursor, setCursor] = useState<Reading | null>(null);

  const help = useId();
  const status = useId();

  const period = useMemo(
    () => (periodKey === null ? null : scatterWindow(periodKey, granularity)),
    [periodKey, granularity],
  );
  const days = useMemo(
    () => (period === null ? [] : frameDays(period, watched)),
    [period, watched],
  );
  const source = frameSource(days);

  /*
   * The boards, filtered to the dates the boards may speak for.
   *
   * `flightPoints` places every offer whose departure falls inside the window,
   * and the window now runs past the end of the watched month. The archive is
   * narrowed to the watched reading before it reaches this component, so in
   * practice nothing outside it arrives — but a board dot on a date the curve
   * also answers for would be two archives contradicting each other in one
   * column, and the frame is the one place that can refuse it.
   */
  const points = useMemo(
    () =>
      period === null
        ? []
        : flightPoints(snapshots, period).filter((point) => isWatched(point.day, watched)),
    [snapshots, period, watched],
  );
  const marks = useMemo(() => curveMarks(days, curve), [days, curve]);

  /*
   * One vertical scale over both kinds of price. Two would put a fare on the
   * left of the seam and the same fare on its right at different heights, which
   * is the one thing a reader crossing the boundary is trying to compare.
   */
  const span = useMemo(
    () =>
      spanOfPrices([
        ...points.map((point) => point.price),
        ...marks.flatMap((mark) => (mark.price === null ? [] : [mark.price])),
      ]),
    [points, marks],
  );

  const placed = useMemo(
    () => (period === null || span === null ? [] : placePoints(points, period, span, VIEW)),
    [points, period, span],
  );
  const line = useMemo(() => cheapestPerDay(points), [points]);

  /*
   * A departure date inside the *watched month* with no flight on it — 12.232.
   * Outside it there is nothing for this mark to mean: the boards were never
   * asked about those dates and the curve's own two absences are on its marks.
   */
  const absent = useMemo(
    () =>
      period === null
        ? []
        : absentDays(snapshots, period).filter((day) => isWatched(day.day, watched)),
    [snapshots, period, watched],
  );

  const seams = useMemo(() => sourceSeams(days), [days]);
  const runs = useMemo(() => sourceRuns(days), [days]);

  /*
   * The cloud and the rings, held as elements rather than rebuilt each render.
   *
   * Measured on the scatter this replaces: every pointer move sets state, and
   * rebuilt inline the 899 `<circle>` elements are new objects each time, so
   * React walks all of them — 16.9 to 18.4 ms a move in jsdom against 4.3 to
   * 6.1 ms memoised, on exactly the same DOM. That is what keeps 12.12: SVG at
   * this size is not slow, re-creating it on every pointer event is.
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
   * The cursor resolved against what exists now. Stepping a period or flipping
   * the granularity rebuilds every mark under it, and a reading kept from
   * before would name an itinerary that is no longer drawn. Resolving to
   * nothing is the honest outcome — the thing it was on is not on screen.
   */
  const reading = useMemo(() => resolve(cursor, placed, marks), [cursor, placed, marks]);

  const priced = points.length + marks.filter((mark) => mark.price !== null).length;

  if (period === null) {
    return (
      <p className={styles.empty}>
        Nothing collected for this route yet. The first collection pass fills this frame — one dot
        per itinerary in the watched month, and one price a date beyond it.
      </p>
    );
  }

  const previous = keys.indexOf(period.key) > 0;
  const next = keys.indexOf(period.key) >= 0 && keys.indexOf(period.key) < keys.length - 1;
  const ticks = axisTicks(period);
  const separators = dayBoundaries(period);
  const priceTicks = span === null ? [] : niceTicks(span.low, span.high);
  const path = span === null ? '' : cheapestPath(points, period, span, VIEW);
  const caption = boundsLabel({ from: period.from, to: period.to });

  /*
   * The crosshair reads the data and never the pointer's own height — the same
   * rule the price history chart now keeps. The plate under a flight is that
   * flight's fare; the plate over a curve date is that date's price; a date
   * with no price gets no plate at all rather than a number the reader's hand
   * chose.
   */
  const hair = reading === null ? null : hairFor(reading, period, span);
  const priceTagY =
    hair?.y === undefined ? 0 : clampToTrack(hair.y, TAG.height, VIEW.pad.top, PLOT_BOTTOM);
  const priceTag = priceAxisTag(
    VIEW.pad.left - PRICE_GAP,
    hair?.price === undefined ? '' : formatMoney(hair.price, currency),
  );
  const timeTag = timeAxisTag(
    hair?.x ?? 0,
    hair?.label ?? '',
    VIEW.pad.left,
    VIEW.width - VIEW.pad.right,
  );

  /** Pointer position in the units the viewBox is drawn in, never in pixels. */
  const trackPointer = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;
    const x = ((event.clientX - box.left) / box.width) * VIEW.width;
    const y = ((event.clientY - box.top) / box.height) * VIEW.height;

    /*
     * Which date the pointer is over decides which question is being asked, and
     * that is a different snap on each side of the seam. A curve date is one
     * price for a whole column, so anywhere in the column is that date — a
     * two-dimensional snap would let a pointer at the top of an unpriced column
     * jump to a flight in the next one. A board date stacks twenty itineraries
     * in the same column, so there the nearest dot in two dimensions is the
     * only snap that can reach them all.
     */
    const index = dayIndexAt(x, period, days.length);
    const day = days[index];
    if (day !== undefined && day.source === 'curve') {
      const mark = marks.find((entry) => entry.day === day.day);
      if (mark) setCursor({ kind: 'curve', mark, index });
      return;
    }
    const nearest = nearestPlaced(placed, x, y);
    if (nearest !== null) setCursor({ kind: 'flight', placed: placed[nearest] });
  };

  /*
   * Two axes for the keyboard, because the frame has two questions in it.
   *
   * Left and right walk one departure date at a time — the cheapest flight of
   * that date inside the month, the date's own price outside it — so the walk
   * crosses the seam without the reader having to know it is there. Up and down
   * walk that date's board by price, which only a board date has; on a curve
   * date there is one number and nothing to walk through.
   */
  const walk = (event: KeyboardEvent<SVGSVGElement>) => {
    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';
    if (!horizontal && !vertical) return;
    // Otherwise the arrow scrolls the page out from under the chart being read.
    event.preventDefault();

    const stops = walkable(days, line, marks, placed);
    if (stops.length === 0) return;

    if (horizontal) {
      const forward = event.key === 'ArrowRight';
      if (reading === null) {
        // Arriving from nothing, the first press lands on the end the reader is
        // moving away from: right starts at the earliest date, left at the last.
        setCursor(forward ? stops[0] : stops[stops.length - 1]);
        return;
      }
      const at = stops.findIndex((stop) => sameReading(stop, reading));
      const to = Math.min(Math.max(at + (forward ? 1 : -1), 0), stops.length - 1);
      setCursor(stops[to]);
      return;
    }

    if (reading === null || reading.kind !== 'flight') return;
    const board = placed
      .filter((entry) => entry.point.day === reading.placed.point.day)
      .sort((a, b) => a.point.price - b.point.price);
    const at = board.findIndex((entry) => entry.point === reading.placed.point);
    // Up the chart is dearer, which is the direction the price axis runs.
    const to = Math.min(Math.max(at + (event.key === 'ArrowUp' ? 1 : -1), 0), board.length - 1);
    if (board[to]) setCursor({ kind: 'flight', placed: board[to] });
  };

  return (
    <figure className={styles.figure}>
      <div className={styles.head}>
        <p className={styles.window} data-testid="frame-summary">
          <strong>{summary(source, placed.length, marks)}</strong> departing {caption}
        </p>
        {keys.length > 1 ? (
          <div className={styles.steps}>
            <button
              type="button"
              onClick={() => onStep(-1)}
              disabled={!previous}
              aria-label={`Previous ${UNIT[granularity]}`}
            >
              &lsaquo;
            </button>
            <span>
              {keys.indexOf(period.key) + 1} / {keys.length}
            </span>
            <button
              type="button"
              onClick={() => onStep(1)}
              disabled={!next}
              aria-label={`Next ${UNIT[granularity]}`}
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
        aria-label={`${label}. ${accessibleTail(source, placed.length, marks, currency, caption)}`}
        aria-describedby={`${help} ${status}`}
        onPointerMove={trackPointer}
        onPointerLeave={() => setCursor(null)}
        onKeyDown={walk}
        onBlur={() => setCursor(null)}
      >
        {span === null
          ? null
          : priceTicks.map((value) => (
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

        {/* A midnight between two dates, so the frame reads as dates and not as a smear. */}
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

        {/*
          The seam: where the boards stop and the curve starts, and with it
          where the axis stops being a clock. Drawn full height and through the
          rail, because it is a statement about the whole column either side of
          it rather than about the plot alone.
        */}
        {seams.map((offset) => (
          <line
            key={offset}
            x1={xOf(offset, period, VIEW)}
            x2={xOf(offset, period, VIEW)}
            y1={VIEW.pad.top}
            y2={SOURCE_BASELINE + 3}
            className={styles.seam}
            data-testid="source-seam"
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
          The source rail — which archive answered for which stretch of the
          frame, under the dates it covers. This is the indicator the whole
          arrangement needs: twenty points in a day becoming one point a day is
          a change of kind, and a reader who is not told will read it as the
          flights having vanished.
        */}
        {runs.map((run) => (
          <text
            key={`${run.source}-${run.from}`}
            x={xOf(((run.from + run.to) / 2) * MINUTES_PER_DAY, period, VIEW)}
            y={SOURCE_BASELINE}
            className={`${styles.sourceLabel} ${styles.tagMiddle}`}
            data-testid={`source-${run.source}`}
          >
            {SOURCE_WORDS[run.source]}
          </text>
        ))}

        {/*
          A departure date inside the watched month with no flight on it, and
          which kind of nothing it is — 12.232. Under the plot floor, because a
          mark inside the plot at any height reads as a fare.
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

        {/*
          A curve date: one price for the whole date, drawn across the whole
          date. Not a dot — a dot sits at an hour, and this number has none.
        */}
        {span === null
          ? null
          : marks.map((mark) =>
              mark.price === null ? null : (
                <g key={mark.day} className={styles.curveDay} data-testid="curve-day">
                  <title>
                    {formatFlightDate(mark.day)}: {formatMoney(mark.price, currency)} — the cheapest
                    fare for the whole date, with no departure time
                  </title>
                  <line
                    x1={xOf(mark.from, period, VIEW)}
                    x2={xOf(mark.to, period, VIEW)}
                    y1={yOf(mark.price, span, VIEW)}
                    y2={yOf(mark.price, span, VIEW)}
                  />
                </g>
              ),
            )}

        {/* A curve date with no price, on the rail, keeping the two absences apart. */}
        {marks.map((mark) =>
          mark.price !== null ? null : (
            <g
              key={mark.day}
              className={styles.hole}
              data-testid={mark.answered ? 'curve-unsold' : 'curve-unanswered'}
            >
              <title>
                {formatFlightDate(mark.day)}:{' '}
                {mark.answered
                  ? 'nothing on sale — the provider answered and had none'
                  : 'never answered for — the booking horizon does not reach this date'}
              </title>
              {mark.answered ? (
                <rect
                  x={xOf(mark.centre, period, VIEW) - 1.6}
                  y={RAIL_Y - 1.6}
                  width={3.2}
                  height={3.2}
                  className={styles.unsold}
                />
              ) : (
                <circle
                  cx={xOf(mark.centre, period, VIEW)}
                  cy={RAIL_Y}
                  r={2}
                  className={styles.unanswered}
                />
              )}
            </g>
          ),
        )}

        {path ? <path d={path} className={styles.cheapest} aria-hidden="true" /> : null}

        {cloud}
        {rings}

        {hair ? (
          <g className={styles.crosshair} aria-hidden="true" data-testid="departure-crosshair">
            <line
              x1={hair.x}
              x2={hair.x}
              y1={VIEW.pad.top}
              y2={RAIL_Y + 5}
              className={styles.hair}
            />
            {hair.y === undefined || hair.price === undefined ? null : (
              <>
                <line
                  x1={VIEW.pad.left}
                  x2={VIEW.width - VIEW.pad.right}
                  y1={hair.y}
                  y2={hair.y}
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
                  data-testid="departure-price-tag"
                >
                  {formatMoney(hair.price, currency)}
                </text>
              </>
            )}
            {hair.y === undefined ? null : hair.span === undefined ? (
              <circle cx={hair.x} cy={hair.y} r={5} className={styles.marker} />
            ) : (
              <line
                x1={hair.span.from}
                x2={hair.span.to}
                y1={hair.y}
                y2={hair.y}
                className={styles.spanMarker}
              />
            )}

            <rect
              x={timeTag.x}
              y={TAG.top}
              width={timeTag.width}
              height={TAG.height}
              rx={3}
              className={styles.tag}
              data-testid="departure-time-plate"
            />
            <text
              x={timeTag.textX}
              y={TAG.top + TAG.baseline}
              className={`${styles.tagText} ${ANCHOR[timeTag.anchor]}`}
              data-testid="departure-time-tag"
            >
              {hair.label}
            </text>
          </g>
        ) : null}
      </svg>

      {/* Fixed height whether or not anything is under the pointer, so the table below never jumps. */}
      <p className={styles.readout} aria-hidden="true">
        {reading === null ? (
          <span className={styles.hint}>
            Point at the chart, or use the arrow keys — left and right walk one departure date at a
            time.
          </span>
        ) : reading.kind === 'flight' ? (
          <>
            <strong>{flightName(reading.placed.point)}</strong>
            <span className={styles.muted}>
              {reading.placed.point.airlineName ?? reading.placed.point.airline}
            </span>
            <span>{pointTimeLabel(reading.placed.point, period)}</span>
            <span className={styles.muted}>{stopsLabel(reading.placed.point.transfers)}</span>
            <span className={styles.muted}>
              {formatDuration(reading.placed.point.durationMinutes)}
            </span>
            <strong>{formatMoney(reading.placed.point.price, currency)}</strong>
            {reading.placed.point.cheapestOfDay ? (
              <span className={styles.flag}>cheapest of the day</span>
            ) : null}
          </>
        ) : (
          <>
            <strong>{formatFlightDate(reading.mark.day)}</strong>
            <span className={styles.muted}>whole date, no departure time</span>
            {reading.mark.price === null ? (
              <span className={styles.muted}>{absenceWords(reading.mark)}</span>
            ) : (
              <strong>{formatMoney(reading.mark.price, currency)}</strong>
            )}
          </>
        )}
      </p>

      <p id={help} className={styles.srOnly}>
        Left and right arrow keys move one departure date at a time; up and down move through that
        date&rsquo;s board by price, where there is a board to move through.
      </p>
      <p id={status} className={styles.srOnly} role="status">
        {reading === null
          ? ''
          : reading.kind === 'flight'
            ? flightSentence(reading.placed.point, currency)
            : curveSentence(reading.mark, currency)}
      </p>

      {/*
        The vocabulary of the frame, stated in full every time rather than only
        for the marks currently on screen. A legend that grew and shrank as the
        reader stepped across the boundary would move the whole panel under
        them, which is the one thing this arrangement must not do — and the
        marks it names are the ones they are about to meet.
      */}
      <figcaption className={styles.legend}>
        <span className={styles.keyDot}>
          <i /> One dot is one itinerary, at the hour it departs
        </span>
        <span className={styles.keyLine}>
          <i /> The cheapest flight of each date — broken where a date has none
        </span>
        <span className={styles.keySpan}>
          <i /> One price for a whole date — no departure time, so it spans the date
        </span>
        <span className={styles.keyUnsold}>
          <i /> Nothing on sale — we asked and there was none
        </span>
        <span className={styles.keyUnanswered}>
          <i /> Never collected — we have no reading either way
        </span>
      </figcaption>

      {/*
        Why a stretch of this frame is blank, where the reason is us rather than
        the route. `role="alert"` on the failure for 12.237's reason: a request
        that fell over while the reader was looking at the panel is news.
      */}
      <p
        className={styles.note}
        data-testid="horizon-note"
        role={horizonError ? 'alert' : undefined}
      >
        {horizonNote(days, curve, horizonLoading, horizonError, priced)}
      </p>
    </figure>
  );
}

/* ------------------------------------------------------------- the helpers -- */

/** Which date of the frame a horizontal position falls in. */
function dayIndexAt(x: number, window: ScatterWindow, count: number): number {
  const offset = offsetAt(x, window, VIEW);
  return Math.min(Math.max(Math.floor(offset / MINUTES_PER_DAY), 0), Math.max(count - 1, 0));
}

/**
 * The crosshair kept from the last pointer event, resolved against what is
 * drawn now. Object identity rather than an index, because the arrays are
 * rebuilt whenever the period or the granularity moves.
 */
function resolve(
  cursor: Reading | null,
  placed: PlacedPoint[],
  marks: CurveMark[],
): Reading | null {
  if (cursor === null) return null;
  if (cursor.kind === 'flight') {
    const found = placed.find((entry) => entry.point.key === cursor.placed.point.key);
    return found ? { kind: 'flight', placed: found } : null;
  }
  const found = marks.find((mark) => mark.day === cursor.mark.day);
  return found ? { kind: 'curve', mark: found, index: cursor.index } : null;
}

function sameReading(a: Reading, b: Reading): boolean {
  if (a.kind === 'flight' && b.kind === 'flight') return a.placed.point.key === b.placed.point.key;
  if (a.kind === 'curve' && b.kind === 'curve') return a.mark.day === b.mark.day;
  return false;
}

/**
 * Where the crosshair is drawn and what it says, taken from the data under it
 * and never from the pointer's own height.
 *
 * `y` and `price` are absent together: a date with no figure gets no horizontal
 * hairline and no price plate rather than a number invented by where the hand
 * happened to be — 12.234, and now the rule under a pointer too.
 */
function hairFor(
  reading: Reading,
  window: ScatterWindow,
  span: ScatterSpan | null,
): { x: number; y?: number; price?: number; label: string; span?: { from: number; to: number } } {
  if (reading.kind === 'flight') {
    return {
      x: reading.placed.x,
      y: reading.placed.y,
      price: reading.placed.point.price,
      label: pointTimeLabel(reading.placed.point, window),
    };
  }
  const x = xOf(reading.mark.centre, window, VIEW);
  const label = axisDayLabel(reading.mark.day);
  if (reading.mark.price === null || span === null) return { x, label };
  return {
    x,
    y: yOf(reading.mark.price, span, VIEW),
    price: reading.mark.price,
    label,
    span: {
      from: xOf(reading.mark.from, window, VIEW),
      to: xOf(reading.mark.to, window, VIEW),
    },
  };
}

/** Every place the arrow keys can stop, one departure date at a time. */
function walkable(
  days: FrameDay[],
  line: ScatterPoint[],
  marks: CurveMark[],
  placed: PlacedPoint[],
): Reading[] {
  const stops: Reading[] = [];
  for (const day of days) {
    if (day.source === 'board') {
      const cheapest = line.find((point) => point.day === day.day);
      const found = cheapest ? placed.find((entry) => entry.point === cheapest) : undefined;
      if (found) stops.push({ kind: 'flight', placed: found });
      continue;
    }
    const mark = marks.find((entry) => entry.day === day.day);
    if (mark) stops.push({ kind: 'curve', mark, index: day.index });
  }
  return stops;
}

function absenceWords(mark: CurveMark): string {
  return mark.answered
    ? 'nothing on sale — the provider answered and had none'
    : 'never answered for';
}

function curveSentence(mark: CurveMark, currency: string): string {
  const what =
    mark.price === null ? absenceWords(mark) : `cheapest fare ${formatMoney(mark.price, currency)}`;
  return `${formatFlightDate(mark.day)}, the whole departure date with no time of day. ${what}.`;
}

/** What the frame holds, in the head above it. */
function summary(source: FrameSource, flights: number, marks: CurveMark[]): string {
  const dates = marks.filter((mark) => mark.price !== null).length;
  const flightWords = `${flights} flight${flights === 1 ? '' : 's'}`;
  const dateWords = `${dates} priced date${dates === 1 ? '' : 's'}`;
  if (source === 'boards') return flightWords;
  if (source === 'curve') return dateWords;
  return `${flightWords} and ${dateWords}`;
}

function accessibleTail(
  source: FrameSource,
  flights: number,
  marks: CurveMark[],
  currency: string,
  caption: string,
): string {
  const prices = marks.flatMap((mark) => (mark.price === null ? [] : [mark.price]));
  const said = summary(source, flights, marks);
  const range =
    prices.length === 0
      ? ''
      : ` The dates beyond the watched month run ${formatMoney(Math.min(...prices), currency)} to ${formatMoney(Math.max(...prices), currency)}.`;
  return `${said} departing ${caption}.${range}`;
}

/**
 * The sentence under the chart that says why part of it is blank.
 *
 * Three states rather than two — 12.237. A horizon request can be in flight, it
 * can have failed, or it can have come back saying this route has none on disk.
 * Only the last is a fact about the route, and reading a null curve alone
 * reported all three as one.
 */
function horizonNote(
  days: FrameDay[],
  curve: CalendarCurve | null,
  loading: boolean,
  error: Error | null,
  priced: number,
): string {
  const needsCurve = days.some((day) => day.source === 'curve');
  if (!needsCurve) return 'Every date in this frame is inside the watched month.';
  if (error !== null) {
    return `The booking horizon could not be read: ${error.message}. That is a fault at our end and says nothing about what these dates cost.`;
  }
  if (loading) return 'Reading the booking horizon…';
  if (curve === null) {
    return 'The booking horizon has not been collected for this route yet, so the dates outside the watched month are blank. Adding a route now collects its horizon; a route added before that does it needs one collection pass.';
  }
  if (priced === 0) return 'Nothing in this frame carried a price.';
  // The stamp is on the note rather than tucked into a legend, because a curve
  // is only written when something moved: the one on screen can be weeks old,
  // and a price a reader is about to act on has to carry its own age.
  return `Dates outside the watched month come from the booking horizon collected ${collectedAtLabel(curve.capturedAt)} — one price a date, with no carrier and no departure time.`;
}
