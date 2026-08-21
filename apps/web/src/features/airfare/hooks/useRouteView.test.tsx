import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { useRouteView } from '@/features/airfare/hooks/useRouteView';

afterEach(cleanup);

/**
 * What a route remembers about how it was last read.
 *
 * The reading worth pinning here is the one a reader notices immediately and no
 * unit test of the arithmetic can see: that opening a second watch and coming
 * back leaves the first exactly as it was, and that the two do not share a
 * setting between them.
 */

const LIM_SCL = 'LIM-SCL-2026-10';
const LIM_MAD = 'LIM-MAD-2027-03';

describe('useRouteView', () => {
  it('starts a route it has never seen at a day, the earliest departure, and nothing hidden', () => {
    const { result } = renderHook(() => useRouteView(LIM_SCL));
    expect(result.current.view).toEqual({ granularity: 'day', anchor: null, viewport: null });
  });

  it('gives a route back the reading it was left on', () => {
    const { result, rerender } = renderHook(({ route }) => useRouteView(route), {
      initialProps: { route: LIM_SCL },
    });

    act(() => {
      result.current.setGranularity('week');
      result.current.setAnchor('2026-10-09');
    });
    act(() => result.current.setViewport({ start: 2880, span: 1440 }));

    rerender({ route: LIM_MAD });
    expect(result.current.view).toEqual({ granularity: 'day', anchor: null, viewport: null });

    rerender({ route: LIM_SCL });
    expect(result.current.view).toEqual({
      granularity: 'week',
      anchor: '2026-10-09',
      viewport: { start: 2880, span: 1440 },
    });
  });

  it('keeps two watches from sharing a period, a place or a zoom', () => {
    const { result, rerender } = renderHook(({ route }) => useRouteView(route), {
      initialProps: { route: LIM_SCL },
    });

    act(() => result.current.setGranularity('month'));
    rerender({ route: LIM_MAD });
    act(() => result.current.setGranularity('week'));

    expect(result.current.view.granularity).toBe('week');
    rerender({ route: LIM_SCL });
    expect(result.current.view.granularity).toBe('month');
  });

  it('drops the zoom when the period changes, and only then', () => {
    // A day, a week and a month are frames of different lengths, so the same
    // stretch of minutes means somewhere else in each. Being returned to the
    // whole frame is honest; being left somewhere nobody chose is not.
    const { result } = renderHook(() => useRouteView(LIM_SCL));

    act(() => result.current.setViewport({ start: 600, span: 300 }));
    expect(result.current.view.viewport).toEqual({ start: 600, span: 300 });

    act(() => result.current.setGranularity('week'));
    expect(result.current.view.viewport).toBeNull();
  });

  it('holds the zoom when the granularity is set to what it already was', () => {
    // The switch writes on every press, including a press on the live option,
    // and a reader who presses "Day" while already on Day has not asked for
    // their zoom back.
    const { result } = renderHook(() => useRouteView(LIM_SCL));

    act(() => result.current.setViewport({ start: 600, span: 300 }));
    act(() => result.current.setGranularity('day'));

    expect(result.current.view.viewport).toEqual({ start: 600, span: 300 });
  });

  it('keeps the anchor across a period change, because a day means the same at every period', () => {
    const { result } = renderHook(() => useRouteView(LIM_SCL));

    act(() => result.current.setAnchor('2026-10-09'));
    act(() => result.current.setGranularity('month'));

    expect(result.current.view.anchor).toBe('2026-10-09');
  });

  it('still works with no route selected, rather than a switch that does nothing', () => {
    const { result } = renderHook(() => useRouteView(null));

    act(() => result.current.setGranularity('month'));
    expect(result.current.view.granularity).toBe('month');
  });

  it('does not let the empty page and a real watch share a slot', () => {
    const { result, rerender } = renderHook(({ route }) => useRouteView(route), {
      initialProps: { route: null as string | null },
    });

    act(() => result.current.setGranularity('month'));
    rerender({ route: LIM_SCL });

    expect(result.current.view.granularity).toBe('day');
  });
});
