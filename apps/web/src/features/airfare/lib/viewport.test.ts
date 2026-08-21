import { describe, expect, it } from 'vitest';

import {
  MIN_VIEWPORT_MINUTES,
  clampViewport,
  fullViewport,
  isFull,
  panBy,
  spanFactorForWheel,
  visibleDays,
  zoomAt,
  type Viewport,
} from '@/features/airfare/lib/viewport';

/**
 * The zoom's arithmetic, without a browser.
 *
 * What is worth pinning here is everything a reader could only catch by feel:
 * that the date under the pointer holds still while the chart moves around it,
 * that a limit stops the frame rather than sliding it, and that a notch out
 * undoes a notch in. All three are the kind of thing that looks right in a
 * screenshot and is wrong in the hand.
 */

const DAY = 1440;
/** A week, which is the only frame that can hold both kinds of price at once. */
const WEEK = 7 * DAY;

function view(start: number, span: number): Viewport {
  return { start, span };
}

describe('fullViewport', () => {
  it('is the whole frame, which is where every chart starts', () => {
    expect(fullViewport(WEEK)).toEqual({ start: 0, span: WEEK });
  });
});

describe('clampViewport', () => {
  it('never lets the visible stretch run past the end of the frame', () => {
    expect(clampViewport(view(WEEK - 100, DAY), WEEK)).toEqual({
      start: WEEK - DAY,
      span: DAY,
    });
  });

  it('never lets it start before the frame', () => {
    expect(clampViewport(view(-5000, DAY), WEEK)).toEqual({ start: 0, span: DAY });
  });

  it('settles the span before the start, so a zoom-out cannot leave empty canvas', () => {
    // The start is legal against the old span and illegal against the new one.
    // Clamping the start first would keep it and draw two days of nothing on
    // the right of the last date.
    expect(clampViewport(view(WEEK - DAY, 3 * DAY), WEEK)).toEqual({
      start: WEEK - 3 * DAY,
      span: 3 * DAY,
    });
  });

  it('holds the floor on how far in a reader may go', () => {
    expect(clampViewport(view(0, 5), WEEK).span).toBe(MIN_VIEWPORT_MINUTES);
  });

  it('will not be wider than the frame it is a view of', () => {
    expect(clampViewport(view(0, 99 * DAY), WEEK)).toEqual({ start: 0, span: WEEK });
  });

  it('clamps a frame shorter than the floor to the frame rather than to the floor', () => {
    // Cannot arise from a period — the shortest is a day — but a viewport wider
    // than its own frame is the one thing this type must not be able to hold.
    expect(clampViewport(view(0, DAY), 30)).toEqual({ start: 0, span: 30 });
  });
});

describe('isFull', () => {
  it('is true of the whole frame and false of anything narrower', () => {
    expect(isFull(fullViewport(WEEK), WEEK)).toBe(true);
    expect(isFull(view(0, WEEK - DAY), WEEK)).toBe(false);
  });

  it('survives the rounding of a zoom in and back out', () => {
    // Two exact inverses still land a hair short of the frame, and a reset
    // button still lit under a chart that has visibly returned to full is the
    // page disagreeing with itself.
    const inward = zoomAt(fullViewport(WEEK), WEEK, 0.5, 0.37);
    const back = zoomAt(inward, WEEK, 2, 0.37);
    expect(isFull(back, WEEK)).toBe(true);
  });
});

describe('zoomAt', () => {
  it('holds the minute under the anchor still while the frame closes on it', () => {
    const before = fullViewport(WEEK);
    const anchor = 0.25;
    const at = before.start + anchor * before.span;

    const after = zoomAt(before, WEEK, 0.5, anchor);

    expect(after.span).toBe(WEEK / 2);
    expect(after.start + anchor * after.span).toBeCloseTo(at, 6);
  });

  it('holds it just as still on the way out', () => {
    const before = view(2 * DAY, DAY);
    const anchor = 0.8;
    const at = before.start + anchor * before.span;

    const after = zoomAt(before, WEEK, 2, anchor);

    expect(after.span).toBe(2 * DAY);
    expect(after.start + anchor * after.span).toBeCloseTo(at, 6);
  });

  it('zooms about the left edge and the right edge without leaving the frame', () => {
    expect(zoomAt(fullViewport(WEEK), WEEK, 0.5, 0)).toEqual({ start: 0, span: WEEK / 2 });
    expect(zoomAt(fullViewport(WEEK), WEEK, 0.5, 1)).toEqual({
      start: WEEK / 2,
      span: WEEK / 2,
    });
  });

  it('stops at the floor instead of going past it', () => {
    const deep = zoomAt(view(0, MIN_VIEWPORT_MINUTES), WEEK, 0.1, 0.5);
    expect(deep.span).toBe(MIN_VIEWPORT_MINUTES);
  });

  it('does not drift along the frame once a limit is reached', () => {
    // The anchor is honoured against the span actually drawn, not the one
    // asked for. Against the requested span every further notch would slide
    // the frame a little, which the reader reads as the chart fighting them.
    const floored = view(3 * DAY, MIN_VIEWPORT_MINUTES);
    const again = zoomAt(floored, WEEK, 0.25, 0.5);
    expect(again).toEqual(floored);
  });

  it('returns to the whole frame rather than overshooting it', () => {
    const out = zoomAt(view(3 * DAY, DAY), WEEK, 99, 0.5);
    expect(out).toEqual({ start: 0, span: WEEK });
  });

  it('treats an anchor outside the track as its nearest edge', () => {
    expect(zoomAt(fullViewport(WEEK), WEEK, 0.5, -3)).toEqual(
      zoomAt(fullViewport(WEEK), WEEK, 0.5, 0),
    );
    expect(zoomAt(fullViewport(WEEK), WEEK, 0.5, 4)).toEqual(
      zoomAt(fullViewport(WEEK), WEEK, 0.5, 1),
    );
  });
});

describe('panBy', () => {
  it('moves by a fraction of what is visible, so one nudge feels the same at every depth', () => {
    expect(panBy(view(0, DAY), WEEK, 0.5).start).toBe(DAY / 2);
    expect(panBy(view(0, 2 * DAY), WEEK, 0.5).start).toBe(DAY);
  });

  it('runs backwards on a negative fraction', () => {
    expect(panBy(view(3 * DAY, DAY), WEEK, -1).start).toBe(2 * DAY);
  });

  it('stops at either end rather than showing canvas beyond the frame', () => {
    expect(panBy(view(0, DAY), WEEK, -5)).toEqual({ start: 0, span: DAY });
    expect(panBy(view(WEEK - DAY, DAY), WEEK, 5)).toEqual({ start: WEEK - DAY, span: DAY });
  });

  it('leaves the span alone', () => {
    expect(panBy(view(DAY, 3 * DAY), WEEK, 0.3).span).toBe(3 * DAY);
  });
});

describe('spanFactorForWheel', () => {
  it('reads down and away from the reader as further out', () => {
    expect(spanFactorForWheel(120)).toBeGreaterThan(1);
    expect(spanFactorForWheel(-120)).toBeLessThan(1);
  });

  it('undoes itself exactly, so a notch out returns what a notch in took', () => {
    expect(spanFactorForWheel(120) * spanFactorForWheel(-120)).toBeCloseTo(1, 12);
  });

  it('honours the three delta modes rather than reading every one as pixels', () => {
    // A wheel that reports lines sends 3 where a trackpad sends 100. Read as
    // pixels it takes forty notches to move, which reads as a broken zoom
    // rather than as the wrong unit.
    expect(spanFactorForWheel(3, 1)).toBeCloseTo(spanFactorForWheel(48, 0), 12);
    expect(spanFactorForWheel(1, 2)).toBeCloseTo(spanFactorForWheel(400, 0), 12);
  });

  it('does nothing on a wheel event carrying no delta', () => {
    expect(spanFactorForWheel(0)).toBe(1);
  });
});

describe('visibleDays', () => {
  it('rounds outward, so a day showing only its last hour is on screen', () => {
    // Those two partial days at the edges are exactly the ones a reader who has
    // just panned is looking at, and a label naming them belongs with them.
    expect(visibleDays(view(DAY + 1380, 120), 7, DAY)).toEqual({ from: 1, to: 2 });
  });

  it('is the whole frame at full zoom', () => {
    expect(visibleDays(fullViewport(WEEK), 7, DAY)).toEqual({ from: 0, to: 6 });
  });

  it('never reaches past the last day of the frame', () => {
    expect(visibleDays(view(WEEK - 60, 60), 7, DAY)).toEqual({ from: 6, to: 6 });
  });

  it('collapses to one day when the viewport sits inside it', () => {
    expect(visibleDays(view(2 * DAY + 300, 120), 7, DAY)).toEqual({ from: 2, to: 2 });
  });

  it('refuses a frame with no days rather than reporting its first', () => {
    expect(visibleDays(fullViewport(0), 0, DAY)).toBeNull();
  });
});
