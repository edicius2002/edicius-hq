import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useRouteView } from '@/features/airfare/hooks/useRouteView';

afterEach(cleanup);

/**
 * What a route remembers about how it was last read, and where one it has never
 * been read at starts.
 *
 * The reading worth pinning here is the one a reader notices immediately and no
 * unit test of the arithmetic can see: that opening a second watch and coming
 * back leaves the first exactly as it was, that the two do not share a setting
 * between them, and — since `a-watch-opens-on-its-own-month` — that the opening
 * month is a seed rather than something reapplied on every visit.
 */

const LIM_SCL = 'LIM-SCL-2026-10';
const LIM_MAD = 'LIM-MAD-2027-03';

/**
 * The month each of these watches is on.
 *
 * The route key and the month travel together everywhere this hook is used —
 * the page reads both off one `FareRoute` — so a test that let them disagree
 * would be testing a page that cannot exist.
 */
const MONTHS: Record<string, string> = { [LIM_SCL]: '2026-10', [LIM_MAD]: '2027-03' };

const monthOf = (route: string | null) => (route === null ? null : MONTHS[route]);

describe('useRouteView', () => {
  it('starts a route it has never seen on the whole of its own watched month', () => {
    // `a-watch-opens-on-its-own-month`. The anchor is the first of that month
    // rather than null, because null means "the earliest thing on the axis" and
    // before the history request lands that is the booking horizon's first
    // month — this month — rather than the one being watched.
    const { result } = renderHook(() => useRouteView(LIM_SCL, MONTHS[LIM_SCL]));
    expect(result.current.view).toEqual({
      month: '2026-10',
      granularity: 'month',
      anchor: '2026-10-01',
      viewport: null,
    });
  });

  it('opens each watch on its own month rather than on the first one opened', () => {
    const { result, rerender } = renderHook(({ route }) => useRouteView(route, monthOf(route)), {
      initialProps: { route: LIM_SCL },
    });
    expect(result.current.view.anchor).toBe('2026-10-01');

    rerender({ route: LIM_MAD });
    expect(result.current.view.anchor).toBe('2027-03-01');
  });

  it('gives a route back the reading it was left on', () => {
    const { result, rerender } = renderHook(({ route }) => useRouteView(route, monthOf(route)), {
      initialProps: { route: LIM_SCL },
    });

    act(() => {
      result.current.setGranularity('week');
      result.current.setAnchor('2026-10-09');
    });
    act(() => result.current.setViewport({ start: 2880, span: 1440 }));

    rerender({ route: LIM_MAD });
    expect(result.current.view).toEqual({
      month: '2027-03',
      granularity: 'month',
      anchor: '2027-03-01',
      viewport: null,
    });

    rerender({ route: LIM_SCL });
    expect(result.current.view).toEqual({
      month: '2026-10',
      granularity: 'week',
      anchor: '2026-10-09',
      viewport: { start: 2880, span: 1440 },
    });
  });

  it('leaves a reader who chose the day view on it, rather than reopening on the month', () => {
    /*
     * The half of `a-watch-opens-on-its-own-month` that stops it becoming a
     * bug. The month is where a route with no reading *starts*; it is not a
     * setting reapplied whenever the route is opened. A reader who walked to a
     * single departure day, went to look at another watch and came back to this
     * one would otherwise find the whole month again — the page throwing away a
     * choice it had already shown it remembered, which is the one thing the
     * per-route reading exists to prevent.
     */
    const { result, rerender } = renderHook(({ route }) => useRouteView(route, monthOf(route)), {
      initialProps: { route: LIM_SCL },
    });

    act(() => {
      result.current.setGranularity('day');
      result.current.setAnchor('2026-10-09');
    });

    rerender({ route: LIM_MAD });
    rerender({ route: LIM_SCL });

    expect(result.current.view.granularity).toBe('day');
    expect(result.current.view.anchor).toBe('2026-10-09');
  });

  it('keeps two watches from sharing a period, a place or a zoom', () => {
    const { result, rerender } = renderHook(({ route }) => useRouteView(route, monthOf(route)), {
      initialProps: { route: LIM_SCL },
    });

    act(() => result.current.setGranularity('week'));
    rerender({ route: LIM_MAD });
    act(() => result.current.setGranularity('day'));

    expect(result.current.view.granularity).toBe('day');
    rerender({ route: LIM_SCL });
    expect(result.current.view.granularity).toBe('week');
  });

  it('drops the zoom when the period changes, and only then', () => {
    // A day, a week and a month are frames of different lengths, so the same
    // stretch of minutes means somewhere else in each. Being returned to the
    // whole frame is honest; being left somewhere nobody chose is not.
    const { result } = renderHook(() => useRouteView(LIM_SCL, MONTHS[LIM_SCL]));

    act(() => result.current.setViewport({ start: 600, span: 300 }));
    expect(result.current.view.viewport).toEqual({ start: 600, span: 300 });

    act(() => result.current.setGranularity('week'));
    expect(result.current.view.viewport).toBeNull();
  });

  it('holds the zoom when the granularity is set to what it already was', () => {
    // The switch writes on every press, including a press on the live option,
    // and a reader who presses "Month" while already on Month has not asked for
    // their zoom back.
    const { result } = renderHook(() => useRouteView(LIM_SCL, MONTHS[LIM_SCL]));

    act(() => result.current.setViewport({ start: 600, span: 300 }));
    act(() => result.current.setGranularity('month'));

    expect(result.current.view.viewport).toEqual({ start: 600, span: 300 });
  });

  it('keeps the anchor across a period change, because a day means the same at every period', () => {
    const { result } = renderHook(() => useRouteView(LIM_SCL, MONTHS[LIM_SCL]));

    act(() => result.current.setAnchor('2026-10-09'));
    act(() => result.current.setGranularity('week'));

    expect(result.current.view.anchor).toBe('2026-10-09');
  });

  it('still works with no route selected, rather than a switch that does nothing', () => {
    const { result } = renderHook(() => useRouteView(null, null));
    // No route, so no month to open on and nothing to anchor to — the one place
    // the opening anchor is null.
    expect(result.current.view.anchor).toBeNull();

    act(() => result.current.setGranularity('day'));
    expect(result.current.view.granularity).toBe('day');
  });

  it('does not let the empty page and a real watch share a slot', () => {
    const { result, rerender } = renderHook(({ route }) => useRouteView(route, monthOf(route)), {
      initialProps: { route: null as string | null },
    });

    act(() => result.current.setGranularity('day'));
    rerender({ route: LIM_SCL });

    expect(result.current.view.granularity).toBe('month');
    expect(result.current.view.anchor).toBe('2026-10-01');
  });
});

describe('the month a watch is being read at', () => {
  it('re-anchors and drops the zoom, and keeps the period', () => {
    /*
     * `setGranularity`'s two halves, for the same two reasons. A different
     * month is a different stretch of the departure axis, so "minutes 600 to
     * 900" lands somewhere the reader never chose; a period means the same
     * thing in every month, exactly as a day does at every period.
     */
    const { result } = renderHook(() => useRouteView(LIM_SCL, '2026-10'));

    act(() => result.current.setGranularity('week'));
    act(() => result.current.setViewport({ start: 2880, span: 1440 }));
    act(() => result.current.setMonth('2026-12'));

    expect(result.current.view).toEqual({
      month: '2026-12',
      granularity: 'week',
      anchor: '2026-12-01',
      viewport: null,
    });
  });

  it('is a seed and not a setting, so a walk to another watch and back keeps it', () => {
    // The month half of `a-watch-opens-on-its-own-month`: the opening month
    // fills a record that does not exist yet and never overwrites one.
    const { result, rerender } = renderHook(({ route }) => useRouteView(route, monthOf(route)), {
      initialProps: { route: LIM_SCL },
    });

    act(() => result.current.setMonth('2026-12'));
    rerender({ route: LIM_MAD });
    expect(result.current.view.month).toBe('2027-03');

    rerender({ route: LIM_SCL });
    expect(result.current.view.month).toBe('2026-12');
  });

  it('keeps the month of one watch out of another', () => {
    const { result, rerender } = renderHook(({ route }) => useRouteView(route, monthOf(route)), {
      initialProps: { route: LIM_SCL },
    });

    act(() => result.current.setMonth('2026-12'));
    rerender({ route: LIM_MAD });
    expect(result.current.view.month).toBe('2027-03');
  });
});

describe('reopening a route after its months were edited', () => {
  it('moves the frame even when the month it is handed is the month already held', () => {
    /*
     * The hole `setMonth` cannot cover, and the whole reason `openOn` exists.
     *
     * The tab and the frame live in one record and are not one value: the tab is
     * `month`, the frame is `anchor`. A reader can sit on the first month's tab
     * with the departure chart walked weeks away from it — and `setMonth` opens
     * by returning the record untouched when the month is the month it already
     * holds, which is right for a tab press and silent here.
     */
    const { result } = renderHook(() => useRouteView(LIM_SCL, '2026-10'));

    act(() => result.current.setAnchor('2026-10-25'));
    act(() => result.current.setViewport({ start: 2880, span: 1440 }));

    // The press that does nothing, which is correct of it.
    act(() => result.current.setMonth('2026-10'));
    expect(result.current.view.anchor).toBe('2026-10-25');

    // The edit landing, which must not be silent.
    act(() => result.current.openOn('2026-10'));
    expect(result.current.view.anchor).toBe('2026-10-01');
    expect(result.current.view.viewport).toBeNull();
  });

  it('keeps the period the reader chose', () => {
    // Editing which months are watched says nothing about whether the reader
    // wants days, weeks or months. Resetting that would be the same over-reach
    // `openingView` refuses when it seeds a record rather than reapplying one.
    const { result } = renderHook(() => useRouteView(LIM_SCL, '2026-10'));

    act(() => result.current.setGranularity('week'));
    act(() => result.current.openOn('2026-12'));

    expect(result.current.view.granularity).toBe('week');
    expect(result.current.view.month).toBe('2026-12');
    expect(result.current.view.anchor).toBe('2026-12-01');
  });

  it('leaves every other watch alone', () => {
    const { result, rerender } = renderHook(({ route }) => useRouteView(route, monthOf(route)), {
      initialProps: { route: LIM_SCL },
    });

    act(() => result.current.setAnchor('2026-10-25'));
    rerender({ route: LIM_MAD });
    act(() => result.current.openOn('2027-03'));

    rerender({ route: LIM_SCL });
    expect(result.current.view.anchor).toBe('2026-10-25');
  });
});
