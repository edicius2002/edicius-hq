import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bar } from '@/shared/api/market';

import { CandleChart } from './CandleChart';

/**
 * The chart stopped being the full width of the page when the watchlist moved
 * beside it, and a canvas that is sized from its container has to be told.
 *
 * Deliberately does *not* mock `useElementSize`, which is what every other
 * chart test does — the thing under test here is the measuring path itself:
 * the `ResizeObserver` fires, the hook re-measures, and the backing store is
 * re-allocated. A canvas whose CSS box shrank without its `width` attribute
 * following is not resized, it is squashed, and every candle in it is drawn at
 * the wrong scale.
 *
 * The two widths are the ones measured on the real page at a 1536px window:
 * 1141px of usable page, so the chart frame is 1101px across when the panels
 * are stacked and 761px once the 320px watchlist column and the 20px gap are
 * taken out of it.
 */

const STACKED_FRAME = 1101;
const BESIDE_WATCHLIST = 761;
const FRAME_HEIGHT = 424;

type Observed = { element: Element; fire: () => void };

function bars(count = 200): Bar[] {
  return Array.from({ length: count }, (_, time) => ({
    time,
    open: 100,
    high: 110,
    low: 90,
    close: 105,
    volume: 1,
  }));
}

/** The size jsdom will report for an element, since it lays nothing out. */
function measures(element: Element, width: number) {
  Object.defineProperty(element, 'clientWidth', { value: width, configurable: true });
  Object.defineProperty(element, 'clientHeight', { value: FRAME_HEIGHT, configurable: true });
}

let observed: Observed[] = [];

beforeEach(() => {
  observed = [];
  // jsdom has no 2D context. Returning null is what it would do anyway, and
  // the effect assigns the backing store before it asks for one — so the
  // assignment under test still happens and no candle is ever drawn.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      readonly callback: () => void;

      constructor(callback: () => void) {
        this.callback = callback;
      }

      observe(element: Element) {
        observed.push({ element, fire: () => this.callback() });
      }
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('the chart in its column', () => {
  it('re-allocates its canvas when the column it sits in gets narrower', () => {
    const { container } = render(
      <CandleChart
        bars={bars()}
        viewKey="AAPL:1d"
        symbol="AAPL"
        timeframe="1d"
        isGhost={() => false}
        formatTime={(bar) => String(bar.time)}
      />,
    );

    const [frame] = observed;
    expect(frame).toBeDefined();

    const canvases = [...container.querySelectorAll('canvas')];
    expect(canvases).toHaveLength(2);

    measures(frame.element, STACKED_FRAME);
    act(() => frame.fire());
    for (const canvas of canvases) {
      expect(canvas.width).toBe(STACKED_FRAME);
      expect(canvas.height).toBe(FRAME_HEIGHT);
    }

    // What the watchlist moving beside it does to the chart.
    measures(frame.element, BESIDE_WATCHLIST);
    act(() => frame.fire());
    for (const canvas of canvases) {
      expect(canvas.width).toBe(BESIDE_WATCHLIST);
    }
  });

  it('observes the frame it is drawn into, not the page it is on', () => {
    render(
      <CandleChart
        bars={bars()}
        viewKey="AAPL:1d"
        symbol="AAPL"
        timeframe="1d"
        isGhost={() => false}
        formatTime={(bar) => String(bar.time)}
      />,
    );

    // The canvases are absolutely positioned inside this element and fill it,
    // so it is the only thing whose width answers "how wide is the chart".
    const [frame] = observed;
    expect(frame.element.querySelectorAll('canvas')).toHaveLength(2);
  });
});
