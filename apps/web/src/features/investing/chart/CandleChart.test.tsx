import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Position } from '@/features/investing/data/portfolio';
import type { PriceAlert } from '@/features/investing/data/priceAlerts';
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
    symbol: 'AAPL',
    timeframe: '1d',
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

    rerender(<CandleChart {...chartProps({ viewKey: 'AAPL:1h', bars: bars(300) })} />);
    fireEvent.pointerMove(surface(container), { clientX: 799, clientY: 10 });

    expect(screen.getByText('bar 299')).toBeInTheDocument();
  });

  it('describes the visible range and reads candles with the keyboard', () => {
    const { container } = render(<CandleChart {...chartProps()} />);
    const target = surface(container);

    expect(target).toHaveAttribute('role', 'region');
    expect(target).toHaveAttribute('aria-roledescription', 'candlestick chart');
    expect(target).toHaveAttribute('aria-label', expect.stringContaining('AAPL 1d chart'));
    expect(target).toHaveAttribute('aria-label', expect.stringContaining('bar 80 to bar 199'));

    target.focus();
    fireEvent.keyDown(target, { key: 'ArrowLeft' });

    expect(screen.getByText('bar 198')).toBeInTheDocument();
    expect(
      screen.getByText(/Open 100\.00, high 110\.00, low 90\.00, close 105\.00/),
    ).toBeInTheDocument();
    expect(target).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Viewing historical candles'),
    );
  });

  it('offers the visible OHLC data table only on request', () => {
    render(<CandleChart {...chartProps({ bars: bars(3) })} />);

    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show data table' }));

    expect(screen.getByRole('table')).toHaveAccessibleName(/AAPL 1d visible candle data/);
    expect(screen.getAllByRole('row')).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'Hide data table' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('zooms with the wheel while still following the latest candles', () => {
    const { container } = render(<CandleChart {...chartProps()} />);
    const target = surface(container);

    expect(target).toHaveAttribute('aria-label', expect.stringContaining('Showing 120 bars'));

    fireEvent.wheel(target, { deltaY: -100, clientX: 799, clientY: 100 });

    // Zooming does not mean leaving the live edge: fewer bars, same last one,
    // and the chart still following what arrives next.
    const label = target.getAttribute('aria-label') ?? '';
    expect(label).toContain('Showing 105 bars from bar 95 to bar 199.');
    expect(label).toContain('Following latest candles');
  });

  it('pans and zooms by keyboard without stealing the latest edge back', () => {
    const { container } = render(<CandleChart {...chartProps()} />);
    const target = surface(container);
    target.focus();

    fireEvent.keyDown(target, { key: 'PageUp' });
    expect(target).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Viewing historical candles'),
    );

    fireEvent.keyDown(target, { key: '+' });
    fireEvent.keyDown(target, { key: 'End' });
    expect(screen.getByText('bar 199')).toBeInTheDocument();
  });
});

/**
 * Two fingers on the chart.
 *
 * `fireEvent.pointerDown` with distinct `pointerId`s is not a real pinch — no
 * browser is involved and nothing is captured — but the arithmetic and the
 * gesture's bookkeeping are what break, and both are reachable from here. What
 * a hand on glass actually delivers is not testable in jsdom and is not claimed
 * to be.
 */
describe('CandleChart touch zoom', () => {
  function pinchStart(target: HTMLElement, left: number, right: number) {
    fireEvent.pointerDown(target, { pointerId: 1, clientX: left, clientY: 100 });
    fireEvent.pointerDown(target, { pointerId: 2, clientX: right, clientY: 100 });
  }

  it('closes the window when two fingers spread apart', () => {
    const { container } = render(<CandleChart {...chartProps()} />);
    const target = surface(container);

    expect(target).toHaveAttribute('aria-label', expect.stringContaining('Showing 120 bars'));

    pinchStart(target, 300, 500);
    fireEvent.pointerMove(target, { pointerId: 2, clientX: 700, clientY: 100 });

    // 200px apart to 400px apart halves the span, the same way a wheel notch
    // scales it: the fingers say how much, not which direction by a sign.
    const label = target.getAttribute('aria-label') ?? '';
    expect(label).toContain('Showing 60 bars');
    expect(label).toContain('Following latest candles');
  });

  it('opens it back up when the two fingers come together', () => {
    const { container } = render(<CandleChart {...chartProps({ bars: bars(600) })} />);
    const target = surface(container);

    pinchStart(target, 300, 700);
    fireEvent.pointerMove(target, { pointerId: 2, clientX: 500, clientY: 100 });

    expect(target).toHaveAttribute('aria-label', expect.stringContaining('Showing 240 bars'));
  });

  it('still pans with one finger, and never zooms with it', () => {
    const { container } = render(<CandleChart {...chartProps()} />);
    const target = surface(container);

    fireEvent.pointerDown(target, { pointerId: 1, clientX: 300, clientY: 100 });
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 500, clientY: 100 });

    // The span is the whole assertion: one finger moves the window, and a pan
    // that quietly rescaled it would be the pinch leaking into the drag.
    const label = target.getAttribute('aria-label') ?? '';
    expect(label).toContain('Showing 120 bars');
    expect(label).toContain('Viewing historical candles');
  });

  it('does not jump when one of the two fingers is lifted', () => {
    const { container } = render(<CandleChart {...chartProps()} />);
    const target = surface(container);

    pinchStart(target, 300, 500);
    fireEvent.pointerMove(target, { pointerId: 2, clientX: 700, clientY: 100 });
    const afterPinch = target.getAttribute('aria-label') ?? '';
    expect(afterPinch).toContain('Showing 60 bars');

    fireEvent.pointerUp(target, { pointerId: 2, clientX: 700, clientY: 100 });
    // The finger that is left has not moved, so neither should the window. A
    // drag re-seated on where the gesture *began* pans by the whole width of
    // the pinch on its first move; one seated on where the finger is does not.
    fireEvent.pointerMove(target, { pointerId: 1, clientX: 300, clientY: 100 });

    expect(target).toHaveAttribute('aria-label', afterPinch);
  });

  it('offers a zoom in and a zoom out that need neither a wheel nor a keyboard', () => {
    const { container } = render(<CandleChart {...chartProps()} />);

    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
    expect(surface(container)).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Showing 120 bars'),
    );
  });

  it('closes and opens the window from the buttons alone', () => {
    const { container } = render(<CandleChart {...chartProps()} />);
    const target = surface(container);

    fireEvent.click(screen.getByRole('button', { name: /zoom in/i }));
    const closed = Number(/Showing (\d+) bars/.exec(target.getAttribute('aria-label') ?? '')?.[1]);
    expect(closed).toBeLessThan(120);

    fireEvent.click(screen.getByRole('button', { name: /zoom out/i }));
    const opened = Number(/Showing (\d+) bars/.exec(target.getAttribute('aria-label') ?? '')?.[1]);
    expect(opened).toBeGreaterThan(closed);
  });
});

describe('CandleChart position entry line', () => {
  const position: Position = { symbol: 'AAPL', quantity: 3, averageCost: 100 };

  it('names the entry price for a symbol with an open position', () => {
    const { container } = render(<CandleChart {...chartProps({ position })} />);

    expect(surface(container)).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Position entry at 100.00.'),
    );
  });

  it('says nothing about an entry when the symbol has no position', () => {
    const { container } = render(<CandleChart {...chartProps()} />);

    expect(surface(container)).not.toHaveAttribute(
      'aria-label',
      expect.stringContaining('Position entry'),
    );
  });
});

describe('CandleChart price alert lines', () => {
  const buyAlert: PriceAlert = {
    id: 'a1',
    symbol: 'AAPL',
    kind: 'buy',
    price: 200,
    active: true,
    createdAt: 0,
    triggeredAt: null,
  };
  const sellAlert: PriceAlert = { ...buyAlert, id: 'a2', kind: 'sell', price: 260 };

  it('names each active alert for a screen reader, since the dotted line itself is invisible to one', () => {
    const { container } = render(
      <CandleChart {...chartProps({ alerts: [buyAlert, sellAlert] })} />,
    );

    expect(surface(container)).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Buy alert at 200.00. Sell alert at 260.00.'),
    );
  });

  it('says nothing about an alert when there are none', () => {
    const { container } = render(<CandleChart {...chartProps()} />);

    expect(surface(container)).not.toHaveAttribute(
      'aria-label',
      expect.stringContaining('alert at'),
    );
  });

  it('names both a position entry and an alert together without one crowding out the other', () => {
    const position: Position = { symbol: 'AAPL', quantity: 3, averageCost: 100 };
    const { container } = render(<CandleChart {...chartProps({ position, alerts: [buyAlert] })} />);

    const label = surface(container).getAttribute('aria-label') ?? '';
    expect(label).toContain('Position entry at 100.00.');
    expect(label).toContain('Buy alert at 200.00.');
  });
});
