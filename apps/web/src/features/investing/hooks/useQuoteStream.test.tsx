import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QuoteStreamOptions } from '@/features/investing/data/quoteStream';

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
  it('keeps a tick that arrived after the sweep data, while discarding an older one', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    stream.open.mockImplementation((_symbols: string[], options: QuoteStreamOptions) => {
      options.onTicks([
        {
          symbol: 'AAPL',
          price: 311,
          marketState: 'REGULAR',
          extended: false,
          changePercent: 4,
          time: 100,
        },
        {
          symbol: 'MSFT',
          price: 412,
          marketState: 'REGULAR',
          extended: false,
          changePercent: 4,
          // Arrived while the sweep was in flight, after its data timestamp.
          time: 101,
        },
        {
          symbol: 'NVDA',
          price: 500,
          marketState: 'REGULAR',
          extended: false,
          changePercent: 4,
          // No ordering proof: it must not be silently replaced by REST.
          time: null,
        },
      ]);
      return vi.fn();
    });

    const { result } = renderHook(() => useQuoteStream(['AAPL']));

    expect(result.current.ticks.get('AAPL')?.price).toBe(311);
    act(() => result.current.discardTicksBefore(100));

    expect(result.current.ticks.has('AAPL')).toBe(false);
    expect(result.current.ticks.get('MSFT')?.price).toBe(412);
    expect(result.current.ticks.get('NVDA')?.price).toBe(500);
  });
});
