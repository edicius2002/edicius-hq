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
      granularity: 'month',
      anchor: '2027-03-01',
      viewport: null,
    });

    rerender({ route: LIM_SCL });
    expect(result.current.view).toEqual({
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
