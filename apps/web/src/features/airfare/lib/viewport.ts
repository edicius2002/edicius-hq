/**
 * How much of a frame is on screen — the zoom, as a stretch of the frame's own
 * minutes rather than as a scale factor.
 *
 * **Minutes rather than a multiplier**, because every other measurement on the
 * departure chart is already in minutes from the start of the frame: a
 * flight's `offset`, a curve date's `centre`, an axis tick, a midnight
 * separator. A viewport in the same unit composes with all of them by
 * subtraction, where a scale factor and a centre would have to be turned back
 * into minutes at every call site — and each of those conversions is a place to
 * get the anchor wrong.
 *
 * The frame it is a view of is *not* held here. A viewport is a pair of numbers
 * and the frame's own length is passed in wherever the two have to be compared,
 * so this module knows nothing about calendars, periods or granularities and
 * can be tested with arithmetic alone. It is also why `flightScatter` can take
 * a `Viewport` without this file importing anything back from it.
 */

/**
 * The visible stretch: where it starts, and how long it is.
 *
 * Both in minutes from the start of the frame. `start` is never negative and
 * `start + span` never runs past the frame's end — `clampViewport` is the only
 * thing that constructs one, and every function here returns through it.
 */
export type Viewport = { start: number; span: number };

/**
 * The floor on how far in a reader may go: one hour of the frame.
 *
 * A number rather than "some fraction of the frame", because what makes a zoom
 * useless is not the ratio but the absolute width — an hour across the whole
 * plot is already 620 view units for at most a handful of departures, and there
 * is nothing finer for the axis to say. The same floor therefore reads as 24×
 * on a day view and 744× on a month, which is correct: the month has more to
 * get through.
 */
export const MIN_VIEWPORT_MINUTES = 60;

/** The whole frame, which is where every chart starts and what reset returns to. */
export function fullViewport(spanMinutes: number): Viewport {
  return { start: 0, span: Math.max(spanMinutes, 0) };
}

/**
 * A viewport confined to its frame, and to the floor.
 *
 * The order matters and is the whole of the function: the span is settled
 * first, then the start is confined to what that span leaves. Doing it the
 * other way lets a start clamped against the *old* span sit past the end once
 * the span has grown, which is how a zoom-out ends up showing empty canvas on
 * the right of the last date.
 *
 * A frame shorter than the floor clamps to the frame rather than to the floor.
 * That cannot arise from a period — the shortest is a day, which is 1,440
 * minutes — but a caller handed a degenerate frame should get a viewport of it
 * rather than one wider than the thing it is a view of.
 */
export function clampViewport(view: Viewport, spanMinutes: number): Viewport {
  const frame = Math.max(spanMinutes, 0);
  const floor = Math.min(MIN_VIEWPORT_MINUTES, frame);
  const span = Math.min(Math.max(view.span, floor), frame);
  const start = Math.min(Math.max(view.start, 0), frame - span);
  return { start, span };
}

/**
 * True where nothing is hidden.
 *
 * Asked by the reset affordance, which should not offer to undo a zoom nobody
 * has applied, and by the announcement, which should not read out a range that
 * is simply the frame. A tolerance rather than equality because the span
 * arrives here through a chain of multiplications: a reader who zooms in and
 * back out lands a rounding error short of the frame, and a button that stays
 * lit after the chart has visibly returned to full is the page disagreeing with
 * itself.
 */
export function isFull(view: Viewport, spanMinutes: number): boolean {
  return view.span >= Math.max(spanMinutes, 0) - 0.5;
}

/**
 * Zoom about a fixed point of the track.
 *
 * `anchor` is a fraction of the *visible* track, 0 at its left edge and 1 at
 * its right, which is what a pointer position converts to directly. The minute
 * under it is computed before the span changes and put back at the same
 * fraction after, so the date the reader is pointing at is the one thing that
 * does not move. That is the entire reason this takes an anchor at all: a zoom
 * about the centre makes the reader chase the thing they were looking at
 * towards the edge of the frame, and chasing it is what the arrows are for.
 *
 * `spanFactor` multiplies the visible span, so below 1 is closer in and above 1
 * is further out. Stated that way round because it is the span this returns and
 * the span the caller can reason about; "zoom level" would need a convention
 * about which direction is bigger, and that convention is exactly what gets
 * inverted by mistake.
 *
 * The anchor is honoured against the *clamped* span rather than the requested
 * one. At the floor and at full frame the requested span is not what is drawn,
 * and holding the point against a width the chart is not showing slides the
 * frame a little on every event once a limit is reached — a drift the reader
 * reads as the chart fighting them.
 */
export function zoomAt(
  view: Viewport,
  spanMinutes: number,
  spanFactor: number,
  anchor: number,
): Viewport {
  const held = Math.min(Math.max(anchor, 0), 1);
  const at = view.start + held * view.span;
  const frame = Math.max(spanMinutes, 0);
  const floor = Math.min(MIN_VIEWPORT_MINUTES, frame);
  const span = Math.min(Math.max(view.span * spanFactor, floor), frame);
  return clampViewport({ start: at - held * span, span }, spanMinutes);
}

/**
 * Move the visible stretch along the frame, by a fraction of what is visible.
 *
 * A fraction of the visible span rather than of the frame, so one press or one
 * drag covers the same *proportion of what is on screen* at every zoom. In
 * frame units a step that is a comfortable nudge across a month is a leap
 * across an hour.
 *
 * Positive moves forward in time. At either end the clamp simply stops it,
 * which is the honest outcome — there is no more frame over there, and the
 * period arrows are the way out.
 */
export function panBy(view: Viewport, spanMinutes: number, fraction: number): Viewport {
  return clampViewport({ start: view.start + fraction * view.span, span: view.span }, spanMinutes);
}

/**
 * A wheel notch as a span multiplier.
 *
 * `deltaMode` is honoured because the three modes are not the same number: a
 * trackpad sends pixels, a wheel on some platforms sends lines, and a page
 * scroll sends pages. Treating all three as pixels makes one line feel like one
 * pixel, and the chart then needs forty notches to move — which reads as the
 * zoom being broken rather than as the units being wrong.
 *
 * Exponential in the delta so that a notch out undoes a notch in exactly, and
 * so that zooming feels the same at every depth. The base is deliberately close
 * to 1: it takes roughly a full trackpad flick to halve the span, which is what
 * makes the anchored point readable while it happens.
 *
 * Down and away from the reader is out, matching every map they have used.
 */
export function spanFactorForWheel(deltaY: number, deltaMode = 0): number {
  const perUnit = deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1;
  return Math.pow(1.0015, deltaY * perUnit);
}

/**
 * Which of a frame's days the viewport can see, as a pair of indices.
 *
 * Both inclusive, and rounded *outward*: a day showing only its last hour is on
 * screen, and a label naming it belongs on screen with it. Rounding inward
 * would drop the two partial days at the edges, which are precisely the ones a
 * reader who has just panned is looking at.
 *
 * `null` where the frame holds no days at all, so a caller cannot mistake an
 * empty frame for one showing its first day.
 */
export function visibleDays(
  view: Viewport,
  days: number,
  minutesPerDay: number,
): { from: number; to: number } | null {
  if (days <= 0 || minutesPerDay <= 0) return null;
  const first = Math.floor(view.start / minutesPerDay);
  const last = Math.ceil((view.start + view.span) / minutesPerDay) - 1;
  return {
    from: Math.min(Math.max(first, 0), days - 1),
    to: Math.min(Math.max(last, first), days - 1),
  };
}
