import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Bar } from '@/shared/api/market';

import { CandleChart } from './CandleChart';

vi.mock('@/shared/lib/useElementSize', () => ({
  useElementSize: () => [vi.fn(), { width: 864, height: 424 }],
}));

beforeEach(() => {
  // The tests exercise the interaction layer, not canvas pixels; jsdom has no
  // 2D context and emits a noisy "not implemented" error before returning null.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => vi.restoreAllMocks());

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

function chartProps(over: Partial<React.ComponentProps<typeof CandleChart>> = {}) {
  return {
    bars: bars(),
    viewKey: 'AAPL:1d',
    initialWindow: { first: 20, last: 140 },
    onWindowChange: vi.fn(),
    isGhost: () => false,
    formatTime: (bar: Bar) => `bar ${bar.time}`,
    ...over,
  };
}

function surface(container: HTMLElement): HTMLElement {
  const element = container.querySelector('canvas + canvas + div');
  if (!element) throw new Error('chart interaction surface missing');
  return element as HTMLElement;
}

describe('CandleChart view persistence boundary', () => {
  it('starts the crosshair in the restored index window', () => {
    const { container } = render(<CandleChart {...chartProps()} />);

    fireEvent.pointerMove(surface(container), { clientX: 0, clientY: 10 });

    // x=0 is half a slot before the first candle and rounds to the first saved bar.
    expect(screen.getByText('bar 20')).toBeInTheDocument();
  });

  it('persists a deliberate zoom, rather than only changing its local view', () => {
    const onWindowChange = vi.fn();
    const { container } = render(<CandleChart {...chartProps({ onWindowChange })} />);

    fireEvent.wheel(surface(container), { clientX: 200, clientY: 100, deltaY: -1 });

    expect(onWindowChange).toHaveBeenCalledTimes(1);
    expect(
      onWindowChange.mock.calls[0][0].last - onWindowChange.mock.calls[0][0].first,
    ).toBeLessThan(120);
  });

  it('uses the other saved window when the selected series changes', () => {
    const { container, rerender } = render(<CandleChart {...chartProps()} />);

    rerender(
      <CandleChart
        {...chartProps({ viewKey: 'AAPL:1h', initialWindow: { first: 60, last: 180 } })}
      />,
    );
    fireEvent.pointerMove(surface(container), { clientX: 0, clientY: 10 });

    expect(screen.getByText('bar 60')).toBeInTheDocument();
  });
});
