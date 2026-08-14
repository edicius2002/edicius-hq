import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const stream = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock('@/features/investing/data/quoteStream', () => ({
  openQuoteStream: stream.open,
}));

import { useQuoteStream } from './useQuoteStream';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  stream.open.mockReset();
});

describe('useQuoteStream', () => {
  it('discards overlays when the next REST sweep takes ownership', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    stream.open.mockImplementation((_symbols, options) => {
      options.onTicks([
        {
          symbol: 'AAPL',
          price: 312,
          marketState: 'REGULAR',
          extended: false,
          changePercent: 4,
          time: 10,
        },
      ]);
      return vi.fn();
    });

    const { result } = renderHook(() => useQuoteStream(['AAPL']));

    expect(result.current.ticks.get('AAPL')?.price).toBe(312);
    act(() => result.current.discardTicks());
    expect(result.current.ticks).toEqual(new Map());
  });
});
