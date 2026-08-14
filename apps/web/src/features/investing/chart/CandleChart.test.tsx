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

describe('CandleChart live-edge follow', () => {
  it('starts at the newest candles', () => {
    const { container } = render(<CandleChart {...chartProps()} />);

    fireEvent.pointerMove(surface(container), { clientX: 799, clientY: 10 });

    expect(screen.getByText('bar 199')).toBeInTheDocument();
  });

  it('rejoins the latest candles after panning into history', () => {
    const { container } = render(<CandleChart {...chartProps()} />);

    fireEvent.pointerDown(surface(container), { pointerId: 1, clientX: 400, clientY: 100 });
    fireEvent.pointerMove(surface(container), { pointerId: 1, clientX: 700, clientY: 100 });
    fireEvent.pointerUp(surface(container), { pointerId: 1 });
    fireEvent.pointerMove(surface(container), { clientX: 799, clientY: 10 });

    expect(screen.queryByText('bar 199')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Latest' }));
    fireEvent.pointerMove(surface(container), { clientX: 799, clientY: 10 });

    expect(screen.getByText('bar 199')).toBeInTheDocument();
  });

  it('follows the latest candles again after changing series', () => {
    const { container, rerender } = render(<CandleChart {...chartProps()} />);

    rerender(
      <CandleChart
        {...chartProps({ viewKey: 'AAPL:1h', bars: bars(300) })}
      />,
    );
    fireEvent.pointerMove(surface(container), { clientX: 799, clientY: 10 });

    expect(screen.getByText('bar 299')).toBeInTheDocument();
  });
});
