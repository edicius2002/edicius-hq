import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';

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
  railLabels,
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
  clockLabel,
  dayBoundaries,
  dayPlus,
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
import {
  clampViewport,
  fullViewport,
  isFull,
  panBy,
  spanFactorForWheel,
  visibleDays,
  zoomAt,
  type Viewport,
} from '@/features/airfare/lib/viewport';
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
/** The two edges the frame is drawn between, and the width they leave. */
const LEFT = VIEW.pad.left;
const RIGHT = VIEW.width - VIEW.pad.right;
const TRACK = RIGHT - LEFT;
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

/**
 * The affordances, in one sentence, for a reader who is not looking at the plot.
 *
 * A constant rather than JSX because it is said in two places and must not
 * drift between them: the screen reader hears it through `aria-describedby`,
 * and a pointer finds it on the chart's own `title`. It used to be a paragraph
 * under the plot — which it never visibly was, being `srOnly` throughout, but
 * it was the first of three descriptions concatenated onto one chart and so the
 * whole of it was read out before every fare the crosshair landed on.
 */
const HELP =
  'Left and right arrow keys move one departure date at a time; up and down move through that ' +
  'date’s board by price, where there is a board to move through. Plus and minus close and open ' +
  'the frame around whatever the crosshair is on, zero returns to the whole period, and shift ' +
  'with left or right moves the frame along it. The wheel and a drag do the same with a pointer.';

/**
 * How far one keyboard press moves the frame, as a fraction of what is on
 * screen.
 *
 * A quarter rather than a whole screen: a press that replaced everything would
 * make the reader re-find their place on every one, and what they are doing
 * with these keys is following something across the boundary. The wheel and the
 * drag have no equivalent constant because the hand supplies its own step.
 */
const KEY_PAN = 0.25;

/** And how much one press closes or opens the frame by. */
const KEY_ZOOM = 1.6;

/**
 * How far the pointer must travel before a press counts as a drag.
 *
 * Without it every click is a one-pixel pan that clears the crosshair, so a
 * reader who clicks a dot to hold their place loses the reading they clicked
 * for. Four units is past the tremor and well inside the gap between two dots.
 */
const DRAG_SLOP = 4;

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
  /**
   * How much of the frame is on screen, or null for the whole of it.
   *
   * A prop rather than state here, and for 12.170's reason carried to a second
   * value: this component is unmounted by the chart switch and remounted on
   * every route change, and a reader who zoomed into one morning and looked at
   * the price history should find that morning again when they come back. The
   * crosshair is *not* held that way and still is not — a pointer position is
   * not a place the reader chose to be.
   */
  viewport: Viewport | null;
  /** Null where nothing is hidden, so "the whole frame" has one spelling. */
  onViewportChange: (viewport: Viewport | null) => void;
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
  viewport,
  onViewportChange,
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
  /** What the zoom has left on screen, announced rather than only drawn. */
  const range = useId();
  /** The clip the zoom draws inside — an id per instance, since two charts can be mounted. */
  const clip = useId();

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
   * The zoom, resolved against the frame that exists right now.
   *
   * Clamped here rather than trusted, because the stored viewport outlives the
   * frame it was measured in: the reader who left a route zoomed into six hours
   * of a week comes back to a frame the archive may have grown under, and a
   * span wider than its own frame would draw the plot from off its own left
   * edge. `null` means the whole frame, which is also what a reset writes back,
   * so "nothing hidden" has exactly one spelling in the stored state.
   */
  const frameSpan = period?.spanMinutes ?? 0;
  const view = useMemo(
    () => clampViewport(viewport ?? fullViewport(frameSpan), frameSpan),
    [viewport, frameSpan],
  );
  const zoomed = !isFull(view, frameSpan);

  /*
   * The one way the zoom is written, so "nothing hidden" has one spelling.
   *
   * A viewport that has come back to the whole frame is stored as `null` rather
   * than as a pair of numbers that happen to equal it. Otherwise a reader who
   * zooms in and back out leaves behind a stored range a rounding error short of
   * the frame, and every later comparison — is this route zoomed, should the
   * reset be offered — has to know about that error rather than reading a null.
   */
  const write = (next: Viewport) => {
    onViewportChange(isFull(next, frameSpan) ? null : next);
  };

  /*
   * The wheel is bound by hand rather than with `onWheel`, and that is not a
   * style choice.
   *
   * React attaches `wheel` at the root as a **passive** listener, and
   * `preventDefault` inside a passive listener is ignored — with a warning in
   * the console and no other symptom. Bound through JSX the zoom would work
   * perfectly and scroll the page out from under the chart at the same time,
   * which reads as the chart running away rather than as a listener option.
   *
   * The anchor is `clientX` against `getBoundingClientRect`, never `offsetX`. A
   * synthetic `WheelEvent` carries `offsetX` as 0, so a handler reading it
   * anchors every scripted zoom at the left edge of the plot and sails off the
   * frame — the same trap the map's wheel handler is still in, and the reason
   * four verification attempts were lost to a map that looked broken and was
   * not. Read this way a scripted wheel and a real one land in the same place,
   * so what a test sees is what a reader sees.
   */
  const svg = useRef<SVGSVGElement | null>(null);
  const latest = useRef({ view, frameSpan, write });
  useEffect(() => {
    latest.current = { view, frameSpan, write };
  });

  const drawn = period !== null;
  useEffect(() => {
    const node = svg.current;
    if (node === null) return;

    const onWheel = (event: WheelEvent) => {
      const { view: held, frameSpan: frame, write: put } = latest.current;
      if (frame <= 0 || event.deltaY === 0) return;
      const box = node.getBoundingClientRect();
      if (box.width === 0) return;
      event.preventDefault();
      const x = ((event.clientX - box.left) / box.width) * VIEW.width;
      const anchor = (x - LEFT) / (TRACK || 1);
      put(zoomAt(held, frame, spanFactorForWheel(event.deltaY, event.deltaMode), anchor));
    };

    node.addEventListener('wheel', onWheel, { passive: false });
    return () => node.removeEventListener('wheel', onWheel);
  }, [drawn]);

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
    () => (period === null || span === null ? [] : placePoints(points, period, span, VIEW, view)),
    [points, period, span, view],
  );
  const line = useMemo(() => cheapestPerDay(points), [points]);

  /*
   * What the zoom has left on screen — and what it deliberately has not
   * changed.
   *
   * **The price scale is built from the whole frame**, a few lines above, and
   * that is the invariant this split exists to protect. A vertical scale
   * rebuilt from the visible dots would make every dot jump as the reader
   * panned, so a fare would sit at one height before the drag and another after
   * it, and the one comparison this chart is for — is this departure dear or
   * cheap — would be against a ruler that moves.
   *
   * **Everything a reader can point at, walk to, or hear read out is the
   * visible set.** A crosshair on a dot that has just been panned off the plot
   * resolves to nothing, which is the same rule the period step already keeps:
   * the thing it was on is not on screen. The alternative is a hairline drawn
   * over the price axis reporting a flight nobody can see.
   *
   * The *drawing* stays whole and is clipped. The cheapest-flight line has to
   * run to the edge of the plot rather than stop at the last visible date, or
   * the zoom would invent a gap in a series that has none.
   */
  const shown = useMemo(() => visibleDays(view, days.length, MINUTES_PER_DAY), [view, days.length]);
  const shownDays = useMemo(
    () => (shown === null ? days : days.slice(shown.from, shown.to + 1)),
    [days, shown],
  );
  const shownPlaced = useMemo(
    () => placed.filter((entry) => entry.x >= LEFT - 0.01 && entry.x <= RIGHT + 0.01),
    [placed],
  );
  const shownMarks = useMemo(() => {
    const dates = new Set(shownDays.map((day) => day.day));
    return marks.filter((mark) => dates.has(mark.day));
  }, [marks, shownDays]);

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
  /*
   * The rail names the archive answering for each stretch *on screen* rather
   * than for the frame. Its words sit under the dates they cover, so a rail
   * built from the whole frame would, under a zoom, put "flights, by hour"
   * under a stretch the reader can see is a row of whole-date spans.
   */
  const rail = useMemo(() => railLabels(shownDays, TRACK), [shownDays]);

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
        {shownPlaced.map((entry) => (
          <circle key={entry.point.key} cx={entry.x} cy={entry.y} r={2.6} />
        ))}
      </g>
    ),
    [shownPlaced],
  );

  const rings = useMemo(
    () => (
      <g className={styles.rings} aria-hidden="true" data-testid="cheapest-rings">
        {shownPlaced
          .filter((entry) => entry.point.cheapestOfDay)
          .map((entry) => (
            <circle key={entry.point.key} cx={entry.x} cy={entry.y} r={4.2} />
          ))}
      </g>
    ),
    [shownPlaced],
  );

  /*
   * The cursor resolved against what exists now. Stepping a period or flipping
   * the granularity rebuilds every mark under it, and a reading kept from
   * before would name an itinerary that is no longer drawn. Resolving to
   * nothing is the honest outcome — the thing it was on is not on screen.
   */
  const reading = useMemo(
    () => resolve(cursor, shownPlaced, shownMarks),
    [cursor, shownPlaced, shownMarks],
  );

  /**
   * The drag in progress, or nothing.
   *
   * `from` is the viewport's own start at the moment the press landed, and every
   * move is measured against it rather than against the previous move. Summing
   * deltas accumulates the rounding of each one, and the frame then fails to
   * come back to where it started when the hand does — a drift that reads as the
   * chart sliding on its own.
   *
   * `moved` is what separates a drag from a click: until the pointer has
   * travelled `DRAG_SLOP` the press is still a click, the crosshair keeps
   * tracking, and nothing pans.
   *
   * **Above the empty-frame return, with the rest of the hooks, and that is not
   * tidiness.** It sat beside the handler that reads it, which is below a
   * `return` this component takes whenever the route has nothing collected yet
   * — so the very first render of a new route called one hook fewer than the
   * render that followed its first pass, and React counts hooks by order. The
   * symptom would not have been a bad drag; it would have been the chart
   * throwing the moment data arrived.
   */
  const drag = useRef<{ pointer: number; clientX: number; from: number; moved: boolean } | null>(
    null,
  );

  const priced = points.length + marks.filter((mark) => mark.price !== null).length;
  const notes = horizonNote(days, curve, horizonLoading, horizonError, priced, marks);

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
  const ticks = axisTicks(period, view);
  const separators = dayBoundaries(period);
  const priceTicks = span === null ? [] : niceTicks(span.low, span.high);
  const path = span === null ? '' : cheapestPath(points, period, span, VIEW, view);
  const caption = boundsLabel({ from: period.from, to: period.to });

  /*
   * The crosshair reads the data and never the pointer's own height — the same
   * rule the price history chart now keeps. The plate under a flight is that
   * flight's fare; the plate over a curve date is that date's price; a date
   * with no price gets no plate at all rather than a number the reader's hand
   * chose.
   */
  const hair = reading === null ? null : hairFor(reading, period, span, view);
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
     * A drag moves the frame and does not move the crosshair. Reading both from
     * one gesture would have the hairline chase the dots it is dragging past,
     * and the readout under the chart would flicker through twenty itineraries
     * on the way.
     *
     * The travel is measured in client pixels, which is the only unit a pointer
     * actually moves in — converting to view units first would make the slop
     * depend on how wide the panel happens to be.
     */
    const held = drag.current;
    if (held !== null && held.pointer === event.pointerId) {
      const travelled = event.clientX - held.clientX;
      if (!held.moved && Math.abs(travelled) < DRAG_SLOP) return;
      held.moved = true;
      setCursor(null);
      const fraction = ((travelled / box.width) * VIEW.width) / (TRACK || 1);
      write(clampViewport({ start: held.from - fraction * view.span, span: view.span }, frameSpan));
      return;
    }

    /*
     * Which date the pointer is over decides which question is being asked, and
     * that is a different snap on each side of the seam. A curve date is one
     * price for a whole column, so anywhere in the column is that date — a
     * two-dimensional snap would let a pointer at the top of an unpriced column
     * jump to a flight in the next one. A board date stacks twenty itineraries
     * in the same column, so there the nearest dot in two dimensions is the
     * only snap that can reach them all.
     */
    const index = dayIndexAt(x, period, days.length, view);
    const day = days[index];
    if (day !== undefined && day.source === 'curve') {
      const mark = shownMarks.find((entry) => entry.day === day.day);
      if (mark) setCursor({ kind: 'curve', mark, index });
      return;
    }
    const nearest = nearestPlaced(shownPlaced, x, y);
    if (nearest !== null) setCursor({ kind: 'flight', placed: shownPlaced[nearest] });
  };

  /*
   * A press starts a drag, and a drag is the only thing that ends it.
   *
   * The pointer is captured so that a hand which leaves the chart mid-drag keeps
   * moving the frame instead of stranding it — panning to the last date means
   * dragging past the edge of the plot, which is exactly when the events would
   * otherwise stop arriving.
   *
   * Only a primary press. A right-click opens the context menu and a middle
   * click is the platform's own scroll, and taking either would be this chart
   * deciding what those buttons mean everywhere.
   */
  const startDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    drag.current = {
      pointer: event.pointerId,
      clientX: event.clientX,
      from: view.start,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const endDrag = (event: PointerEvent<SVGSVGElement>) => {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
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
    /*
     * The zoom on the keyboard, before the walk, because `Shift` with an arrow
     * has to be read as a pan rather than as a walk with a modifier held.
     *
     * A wheel and a drag are the whole of this gesture for a hand, and a chart
     * that can only be zoomed by one is a chart half the readers of this page
     * cannot zoom at all. `+` and `-` are what every viewer uses and `0` is what
     * every browser uses for "back to normal", so none of the three has to be
     * learned.
     *
     * **A keyboard zoom anchors on the crosshair where there is one.** The
     * reader has already said what they are looking at by walking to it, and
     * closing the frame about the middle instead would carry it towards an edge
     * — the same reason the wheel anchors on the pointer.
     */
    if (event.key === '+' || event.key === '=' || event.key === '-' || event.key === '_') {
      event.preventDefault();
      const closer = event.key === '+' || event.key === '=';
      const anchor = hair === null ? 0.5 : (hair.x - LEFT) / (TRACK || 1);
      write(zoomAt(view, frameSpan, closer ? 1 / KEY_ZOOM : KEY_ZOOM, anchor));
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      onViewportChange(null);
      return;
    }

    const horizontal = event.key === 'ArrowLeft' || event.key === 'ArrowRight';
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown';

    if (horizontal && event.shiftKey) {
      event.preventDefault();
      write(panBy(view, frameSpan, event.key === 'ArrowRight' ? KEY_PAN : -KEY_PAN));
      return;
    }

    if (!horizontal && !vertical) return;
    // Otherwise the arrow scrolls the page out from under the chart being read.
    event.preventDefault();

    const stops = walkable(shownDays, line, shownMarks, shownPlaced);
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
    const board = shownPlaced
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
        {/*
          The count, printed as the figure it is.

          It used to read `16 flights departing on 30/11/2026, 00:00 to 23:59`,
          and the half after the number was the x axis spelling itself out in
          words directly above the axis that draws it. The sentence is not lost
          — it is still the chart's accessible name, where it is the only thing
          that can say what the axis says — but a reader looking at the plot has
          the dates under it already, and what they cannot count for themselves
          is how many dots there are.
        */}
        <p className={styles.window} data-testid="frame-summary">
          {summary(source, placed.length, marks)}
        </p>

        {/*
          The chart's own top-right corner: which period is open, and the way
          back out of a zoom.

          Both answer "where in the archive am I looking", so they are one
          cluster rather than two things spread along a row. The period switch is
          deliberately *not* here: it belongs to the tab that opens this chart
          rather than to the chart, and it stands under that tab, where a reader
          who has just pressed "Flights seen" is already looking.
        */}
        <div className={styles.corner}>
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

          {/*
            The way back out of a zoom, beside the arrows that move the frame
            because both are the same kind of control.

            Always rendered and disabled when there is nothing to undo, rather
            than appearing with the first wheel notch. A control that arrives
            when the reader zooms would reflow the corner at the exact moment
            they are watching the chart move, and a disabled button is the
            honest reading anyway: this is a thing you can do, and there is
            currently nothing to do it to.

            The two words became a glyph, which is the whole of the size
            reduction — `Reset zoom` set the width of this cluster while saying
            what a return arrow already says, and the words survive where a
            control's words have to: the accessible name, and the tooltip a
            pointer finds.
          */}
          <button
            type="button"
            className={styles.reset}
            onClick={() => onViewportChange(null)}
            disabled={!zoomed}
            aria-label="Reset zoom"
            title="Reset zoom"
            data-testid="reset-zoom"
          >
            <span aria-hidden="true">&#8634;</span>
          </button>
        </div>
      </div>

      <svg
        ref={svg}
        className={styles.chart}
        viewBox={`0 0 ${VIEW.width} ${VIEW.height}`}
        role="img"
        tabIndex={0}
        aria-label={`${label}. ${accessibleTail(source, placed.length, marks, currency, caption)}`}
        /*
          The description is the affordances, and the two live regions are not
          part of it.

          All three ids used to be listed here, which is what made the chart's
          description the keyboard help immediately followed by whatever the
          crosshair was on — one run-on string, no pause between the last word
          of the help and the flight number, read out in full on every arrival.
          A live region does not need to be pointed at to be announced; being
          `role="status"` is the whole of what makes the readout and the zoom
          range speak, and they still do. What is left here is the thing a
          description is for: what this chart can be asked to do.
        */
        aria-describedby={help}
        aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Shift+ArrowLeft Shift+ArrowRight Plus Minus 0"
        data-zoomed={zoomed ? 'true' : undefined}
        onPointerMove={trackPointer}
        onPointerDown={startDrag}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={endDrag}
        /*
          A drag that leaves the chart is still a drag — the pointer is
          captured, and panning to the last date means dragging past the edge of
          the plot. Clearing the crosshair on the way out would be right for a
          hand that has left and wrong for a hand that is still working.
        */
        onPointerLeave={() => {
          if (drag.current === null) setCursor(null);
        }}
        onKeyDown={walk}
        onBlur={() => setCursor(null)}
      >
        {/*
          The same sentence again, for a hand rather than an ear.

          An SVG has no `title` *attribute* — a tooltip on an SVG element comes
          from a `<title>` child and from nothing else, which is worth writing
          down because the attribute is accepted silently by JSX and by the DOM
          and simply never appears. It does not become the chart's name: an
          `aria-label` beats a `<title>` in the accessible-name calculation, so
          the label above is still what is announced and this is only what
          hovering shows. That ordering is the reason the help can be in both
          places at once without being said twice.
        */}
        <title>{HELP}</title>

        {/*
          What the zoom is allowed to hide.

          Everything placed by a minute of the frame is drawn whole and clipped
          here rather than filtered: the cheapest-flight line has to run to the
          edge of the plot instead of stopping at the last visible date, or a
          zoom would invent a gap in a series that has none. The box reaches
          below the plot floor to take in the rail marks, which are placed by
          date like everything else and would otherwise paint over the axis
          words either side of the track.
        */}
        <clipPath id={clip}>
          <rect x={LEFT} y={VIEW.pad.top} width={TRACK} height={RAIL_Y + 5 - VIEW.pad.top} />
        </clipPath>
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
        <g clipPath={`url(#${clip})`}>
          {separators.map((offset) => (
            <line
              key={offset}
              x1={xOf(offset, period, VIEW, view)}
              x2={xOf(offset, period, VIEW, view)}
              y1={VIEW.pad.top}
              y2={PLOT_BOTTOM}
              className={styles.separator}
              aria-hidden="true"
            />
          ))}

          {/*
          The seam: where the boards stop and the curve starts, and with it
          where the axis stops being a clock. It runs from the top of the plot
          past the date labels and stops above the source rail — a statement
          about the whole column either side of it, but not one that is allowed
          to rule through the words naming the two sides. Where a watched range
          is narrower than the frame the two seams stand a single date apart,
          and taken to the rail they crossed `flights, by hour` twice — found
          on a focused watch, before 12.260 stopped one being possible.
        */}
          {seams.map((offset) => (
            <line
              key={offset}
              x1={xOf(offset, period, VIEW, view)}
              x2={xOf(offset, period, VIEW, view)}
              y1={VIEW.pad.top}
              y2={AXIS_BASELINE + 4}
              className={styles.seam}
              data-testid="source-seam"
              aria-hidden="true"
            />
          ))}
        </g>

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
            x={xOf(tick.offset, period, VIEW, view)}
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
        {rail.map((label) => (
          <text
            key={label.source}
            x={VIEW.pad.left + label.centre}
            y={SOURCE_BASELINE}
            className={`${styles.sourceLabel} ${styles.tagMiddle}`}
            data-testid={`source-${label.source}`}
          >
            {label.text}
          </text>
        ))}

        {/*
          Everything placed by a minute of the frame, clipped to what the zoom
          has left on screen.
        */}
        <g clipPath={`url(#${clip})`}>
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
                  x={xOf(day.offset, period, VIEW, view) - 1.6}
                  y={RAIL_Y - 1.6}
                  width={3.2}
                  height={3.2}
                  className={styles.unsold}
                />
              ) : (
                <circle
                  cx={xOf(day.offset, period, VIEW, view)}
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

          **Faint where the figure is older than the newest one on the chart.**
          The horizon is assembled from every stored curve, so a date the last
          collection never reached is answered by an earlier one — and drawn
          identically it would pass for today's price, which is exactly the
          quiet lie 12.230–12.237 spent a release removing from this panel.
          Opacity rather than a dash: dashed against solid is already spoken
          for here, as cheapest-of-date against whole-date price, and a second
          meaning on the same channel would make both unreadable. Age is a
          matter of degree and so is ink, which is the argument for this
          channel rather than merely the room on it.
        */}
          {span === null
            ? null
            : marks.map((mark) =>
                mark.price === null ? null : (
                  <g
                    key={mark.day}
                    className={
                      mark.inherited ? `${styles.curveDay} ${styles.carried}` : styles.curveDay
                    }
                    data-testid={mark.inherited ? 'curve-day-carried' : 'curve-day'}
                  >
                    <title>
                      {formatFlightDate(mark.day)}: {formatMoney(mark.price, currency)} — the
                      cheapest fare for the whole date, with no departure time
                      {mark.inherited && mark.observedAt !== null
                        ? `, carried over from the collection of ${collectedAtLabel(mark.observedAt)}`
                        : ''}
                    </title>
                    <line
                      x1={xOf(mark.from, period, VIEW, view)}
                      x2={xOf(mark.to, period, VIEW, view)}
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
                    x={xOf(mark.centre, period, VIEW, view) - 1.6}
                    y={RAIL_Y - 1.6}
                    width={3.2}
                    height={3.2}
                    className={styles.unsold}
                  />
                ) : (
                  <circle
                    cx={xOf(mark.centre, period, VIEW, view)}
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
        </g>

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

      {/*
        Fixed height whether or not anything is under the pointer, so the table
        below never jumps.

        The line it shows while nothing is under the crosshair is a placeholder
        holding that height open, not a paragraph. It used to name the arrow
        keys and say what they did — directly beneath a plot whose own `<title>`
        and whose description both say the same thing at length — and seven
        words are enough to tell a reader this row is waiting for them rather
        than broken.
      */}
      <p className={styles.readout} aria-hidden="true">
        {reading === null ? (
          <span className={styles.hint}>Point at the chart, or press an arrow key</span>
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

      {/*
        The affordances, for a reader who cannot see the corner they are in.

        Still a node in the document and still the chart's `aria-describedby`,
        because deleting it would take the only account of the two keyboard axes
        and the three zoom keys that a screen reader ever gets. What changed is
        that it no longer shares that attribute with two live regions, so it is
        read on arrival and not again in front of every fare.
      */}
      <p id={help} className={styles.srOnly}>
        {HELP}
      </p>
      <p id={status} className={styles.srOnly} role="status">
        {reading === null
          ? ''
          : reading.kind === 'flight'
            ? flightSentence(reading.placed.point, currency)
            : curveSentence(reading.mark, currency)}
      </p>

      {/*
        What the zoom has left on screen, said out loud.
        
        A zoom is drawn and nothing else, so a reader who is not looking at the
        plot has no way to know the frame has narrowed under them — and every
        reading after it would be of a stretch they were never told about. Its
        own region rather than a sentence added to the crosshair's, because the
        two change on different gestures and one region would have each
        interrupting the other.
      */}
      <p id={range} className={styles.srOnly} role="status">
        {zoomed ? `Showing ${rangeWords(period, view)} of ${caption}.` : ''}
      </p>

      {/*
        The vocabulary of the frame, stated in full every time rather than only
        for the marks currently on screen. A legend that grew and shrank as the
        reader stepped across the boundary would move the whole panel under
        them, which is the one thing this arrangement must not do — and the
        marks it names are the ones they are about to meet.

        **Names, not sentences.** Every entry was a clause explaining its own
        swatch — five of them, forty-eight words, wrapping to three lines under
        a plot they were describing. A legend is read by looking from a mark on
        the chart to the same mark in the row, and the word beside it only has
        to be the one that says which mark it is; the explanation belongs to
        whatever the reader does next, which is point at it. So each keeps a
        `title` carrying the sentence it used to print, and the two absences
        keep the distinction the whole panel is built on — an answer that came
        back empty is not the same fact as an answer that never came — in the
        two words that are actually different between them.
      */}
      <figcaption className={styles.legend}>
        <span className={styles.keyDot} title="One dot is one itinerary, at the hour it departs">
          <i /> One itinerary
        </span>
        <span
          className={styles.keyLine}
          title="The cheapest flight of each date — broken where a date has none"
        >
          <i /> Cheapest of date
        </span>
        <span
          className={styles.keySpan}
          title="One price for a whole date — no departure time, so it spans the date"
        >
          <i /> Whole-date price
        </span>
        {/*
          Permanent, like every entry beside it. The legend is stated in full
          whatever the frame holds, so the box never changes height — a row
          appearing only when a carried-over price happens to be on screen
          would move the chart under the reader.
        */}
        <span
          className={styles.keyCarried}
          title="A whole-date price from an earlier collection — the last pass did not reach this date"
        >
          <i /> Carried over
        </span>
        <span className={styles.keyUnsold} title="Nothing on sale — we asked and there was none">
          <i /> None on sale
        </span>
        <span
          className={styles.keyUnanswered}
          title="Never collected — we have no reading either way"
        >
          <i /> Never collected
        </span>
      </figcaption>

      {/*
        Why a stretch of this frame is blank, where the reason is us rather than
        the route. `role="alert"` on the failure for 12.237's reason: a request
        that fell over while the reader was looking at the panel is news.

        Every sentence it could be saying is rendered at once and all but one is
        held open by `visibility`, exactly as the chart's own name is — 12.246.
        These sentences are different lengths and wrap to different numbers of
        lines, so a box sized to whichever is showing would push the flight
        table down the page as the reader stepped out of the watched month. The
        stack makes the box as tall as the tallest of them by construction,
        which a `min-height` in ems could only approximate.
      */}
      <p
        className={styles.note}
        data-testid="horizon-note"
        role={horizonError ? 'alert' : undefined}
      >
        <span className={styles.noteStack}>
          {notes.said.map((sentence, index) => (
            <span
              key={sentence}
              className={index === notes.live ? styles.noteLive : styles.noteGhost}
              aria-hidden={index === notes.live ? undefined : true}
              {...(index === notes.live ? { 'data-testid': 'horizon-note-live' } : {})}
            >
              {sentence}
            </span>
          ))}
        </span>
      </p>
    </figure>
  );
}

/* ------------------------------------------------------------- the helpers -- */

/**
 * The visible stretch in words, for the reader who is not looking at the plot.
 *
 * A date and a clock at each end, and the end read as the bound it is: a
 * viewport starting at six with six hours in it is "06:00 to 12:00", which is
 * how anyone would say it, rather than "to 11:59" — the honest last minute and
 * the wrong words.
 */
function rangeWords(window: ScatterWindow, view: Viewport): string {
  const start = window.from.slice(0, 10);
  const at = (minutes: number) => {
    const day = dayPlus(start, Math.floor(minutes / MINUTES_PER_DAY));
    const clock = clockLabel(Math.round(minutes) % MINUTES_PER_DAY);
    return day === null ? clock : `${axisDayLabel(day)} ${clock}`;
  };
  return `${at(view.start)} to ${at(view.start + view.span)}`;
}

/** Which date of the frame a horizontal position falls in. */
function dayIndexAt(x: number, window: ScatterWindow, count: number, view: Viewport): number {
  const offset = offsetAt(x, window, VIEW, view);
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
  view: Viewport,
): { x: number; y?: number; price?: number; label: string; span?: { from: number; to: number } } {
  if (reading.kind === 'flight') {
    return {
      x: reading.placed.x,
      y: reading.placed.y,
      price: reading.placed.point.price,
      label: pointTimeLabel(reading.placed.point, window),
    };
  }
  const x = xOf(reading.mark.centre, window, VIEW, view);
  const label = axisDayLabel(reading.mark.day);
  if (reading.mark.price === null || span === null) return { x, label };
  return {
    x,
    y: yOf(reading.mark.price, span, VIEW),
    price: reading.mark.price,
    label,
    span: {
      from: xOf(reading.mark.from, window, VIEW, view),
      to: xOf(reading.mark.to, window, VIEW, view),
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
 * The sentences under the chart that say why part of it is blank, and which of
 * them is the true one.
 *
 * **All of them rather than the live one**, because the box holding them must
 * not change height as the reader steps across the end of the watched month —
 * they are rendered stacked, and only a set can size a box to its tallest
 * member. Which is live is an index into the same list, so the two cannot
 * disagree.
 *
 * Three states rather than two — 12.237. A horizon request can be in flight, it
 * can have failed, or it can have come back saying this route has none on disk.
 * Only the last is a fact about the route, and reading a null curve alone
 * reported all three as one.
 *
 * The collection stamp is in the sentence rather than tucked into a legend,
 * because a curve is only written when something moved: the one on screen can
 * be weeks old, and a price a reader is about to act on has to carry its age.
 *
 * **And the stamp no longer speaks for the whole frame.** The horizon is
 * assembled from every stored curve, so `capturedAt` is the freshest thing on
 * screen rather than the age of everything on it — printing it alone would
 * claim that freshness for dates that an older collection answered for. Where
 * the frame holds any of those, the sentence names how many and how far back
 * the oldest reaches, which is the figure a reader needs to decide whether to
 * trust the far end.
 */
function horizonNote(
  days: FrameDay[],
  curve: CalendarCurve | null,
  loading: boolean,
  error: Error | null,
  priced: number,
  marks: CurveMark[] = [],
): { said: string[]; live: number } {
  const needsCurve = days.some((day) => day.source === 'curve');
  // Only the priced ones. An absence has no age, and counting the unanswered
  // dates as "carried over" would put a number on the sentence that the chart
  // has drawn nothing for.
  const carried = marks.filter((mark) => mark.inherited && mark.price !== null);
  const oldest = carried.reduce<string | null>(
    (found, mark) =>
      mark.observedAt !== null && (found === null || mark.observedAt < found)
        ? mark.observedAt
        : found,
    null,
  );
  const inherited =
    carried.length === 0 || oldest === null
      ? ''
      : ` ${carried.length} of them ${carried.length === 1 ? 'was' : 'were'} carried over from earlier collections, the oldest from ${collectedAtLabel(oldest)}, and ${carried.length === 1 ? 'is' : 'are'} drawn faint.`;
  const inside = 'Every date here is inside the watched month.';
  const failed = `The booking horizon could not be read: ${error?.message ?? 'no reason given'}. That is a fault at our end and says nothing about what these dates cost.`;
  const pending = 'Reading the booking horizon…';
  const uncollected =
    'The booking horizon has not been collected for this route yet, so the dates outside the watched month are blank. Adding a route now collects its horizon; a route added before that does it needs one collection pass.';
  const empty = 'Nothing in this frame carried a price.';
  const collected = `Dates outside the watched month come from the booking horizon, last collected ${curve === null ? 'earlier' : collectedAtLabel(curve.capturedAt)} — one price a date, with no carrier and no departure time.${inherited}`;

  const said = [inside, failed, pending, uncollected, empty, collected];
  if (!needsCurve) return { said, live: 0 };
  if (error !== null) return { said, live: 1 };
  if (loading) return { said, live: 2 };
  if (curve === null) return { said, live: 3 };
  return { said, live: priced === 0 ? 4 : 5 };
}
