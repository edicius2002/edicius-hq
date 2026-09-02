import { describe, expect, it, vi } from 'vitest';

import type { Position } from '@/features/investing/data/portfolio';
import type { Bar } from '@/shared/api/market';

import { drawPriceLines, positionPriceLine } from './priceLines';

type Spies = {
  setLineDash: ReturnType<typeof vi.fn>;
  beginPath: ReturnType<typeof vi.fn>;
  moveTo: ReturnType<typeof vi.fn>;
  lineTo: ReturnType<typeof vi.fn>;
  stroke: ReturnType<typeof vi.fn>;
  fillText: ReturnType<typeof vi.fn>;
};

/**
 * A stand-in for `CanvasRenderingContext2D` that jsdom cannot supply: every
 * drawing call it needs is a spy, kept apart from the cast-up `ctx` so an
 * assertion never touches the interface's own method type and trips the
 * unbound-method lint rule.
 */
function fakeCtx(): { ctx: CanvasRenderingContext2D; spies: Spies } {
  const spies: Spies = {
    setLineDash: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    fillText: vi.fn(),
  };

  const ctx = {
    strokeStyle: '',
    fillStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: 'left' as CanvasTextAlign,
    textBaseline: 'middle' as CanvasTextBaseline,
    ...spies,
  } as unknown as CanvasRenderingContext2D;

  return { ctx, spies };
}

const BAND = { top: 0, height: 400 };
const PLOT = { width: 800, height: 400 };
// A simple, easy-to-check inverse of a linear price scale over [0, 200].
const scale = (price: number) => 400 - price * 2;

describe('drawPriceLines', () => {
  it('draws the line at the y the scale gives its price', () => {
    const { ctx, spies } = fakeCtx();

    drawPriceLines(ctx, {
      lines: [{ price: 100, label: 'Entry 100.00', color: '#8dd36f' }],
      band: BAND,
      plot: PLOT,
      scale,
    });

    const y = scale(100); // 200
    expect(spies.moveTo).toHaveBeenCalledWith(0, y + 0.5);
    expect(spies.lineTo).toHaveBeenCalledWith(PLOT.width, y + 0.5);
    expect(spies.fillText).toHaveBeenCalledWith('Entry 100.00', PLOT.width + 6, y);
    expect(ctx.strokeStyle).toBe('#8dd36f');
  });

  it('draws a dash pattern no indicator line already uses', () => {
    const { ctx, spies } = fakeCtx();

    drawPriceLines(ctx, {
      lines: [{ price: 50, label: 'x', color: '#fff' }],
      band: BAND,
      plot: PLOT,
      scale,
    });

    expect(spies.setLineDash).toHaveBeenCalledWith([6, 4]);
    // Reset afterwards, the same way every other dashed stroke on this chart does.
    expect(spies.setLineDash).toHaveBeenLastCalledWith([]);
  });

  it('skips a price above the band rather than clamping or stretching it', () => {
    const { ctx, spies } = fakeCtx();

    // scale(-10) = 420, past the bottom of a 400-tall band.
    drawPriceLines(ctx, {
      lines: [{ price: -10, label: 'out of range', color: '#fff' }],
      band: BAND,
      plot: PLOT,
      scale,
    });

    expect(spies.moveTo).not.toHaveBeenCalled();
    expect(spies.fillText).not.toHaveBeenCalled();
  });

  it('skips a price below the top of the band the same way', () => {
    const { ctx, spies } = fakeCtx();

    // scale(250) = -100, above the top of the band.
    drawPriceLines(ctx, {
      lines: [{ price: 250, label: 'out of range', color: '#fff' }],
      band: BAND,
      plot: PLOT,
      scale,
    });

    expect(spies.moveTo).not.toHaveBeenCalled();
    expect(spies.fillText).not.toHaveBeenCalled();
  });

  it('draws nothing at all when there are no lines', () => {
    const { ctx, spies } = fakeCtx();

    drawPriceLines(ctx, { lines: [], band: BAND, plot: PLOT, scale });

    expect(spies.beginPath).not.toHaveBeenCalled();
  });
});

function bar(over: Partial<Bar> = {}): Bar {
  return { time: 0, open: 100, high: 110, low: 90, close: 105, volume: 1, ...over };
}

describe('positionPriceLine', () => {
  const position: Position = { symbol: 'AAPL', quantity: 3, averageCost: 100 };

  it('puts the line at the position price, labelled the same way the axis formats prices', () => {
    const line = positionPriceLine([bar()], position);

    expect(line.price).toBe(100);
    expect(line.label).toBe('Entry 100.00');
  });

  it('colours it the candle "up" green when the latest close sits above the entry', () => {
    const line = positionPriceLine([bar({ close: 105 })], position);

    expect(line.color).toBe('#8dd36f');
  });

  it('colours it the candle "down" red when the latest close sits below the entry', () => {
    const line = positionPriceLine([bar({ close: 95 })], position);

    expect(line.color).toBe('#f08d78');
  });
});
