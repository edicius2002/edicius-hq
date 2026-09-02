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
