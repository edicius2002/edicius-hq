import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { QuoteStreamOptions } from '@/features/investing/data/quoteStream';
import type { LiveBarUpdate } from '@/features/investing/data/liveBars';

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
  it('keeps a tick that arrived while the sweep was in flight', () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    stream.open.mockImplementation((_symbols: string[], options: QuoteStreamOptions) => {
      options.onTicks([
        {
          symbol: 'AAPL',
          price: 312,
          marketState: 'REGULAR',
          extended: false,
          changePercent: 4,
          // Newer than the market snapshot (100), although the response is
          // applied after this tick arrived.
          time: 101,
        },
        {
          symbol: 'MSFT',
          price: 412,
          marketState: 'REGULAR',
          extended: false,
          changePercent: 4,
          time: 100,
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

    expect(result.current.ticks.get('AAPL')?.price).toBe(312);
    act(() =>
      result.current.discardTicksBefore(
        new Map([
          ['AAPL', 100],
          ['MSFT', 100],
          ['NVDA', 100],
        ]),
        999,
      ),
    );

    expect(result.current.ticks.get('AAPL')?.price).toBe(312);
    expect(result.current.ticks.has('MSFT')).toBe(false);
    expect(result.current.ticks.get('NVDA')?.price).toBe(500);
  });

  it('falls back to the response-arrival boundary only when a quote has no market time', () => {
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
      ]);
      return vi.fn();
    });

    const { result } = renderHook(() => useQuoteStream(['AAPL']));
    act(() => result.current.discardTicksBefore(new Map([['AAPL', null]]), 100));

    expect(result.current.ticks.has('AAPL')).toBe(false);
  });

  it('keeps the newest bar per focus key in one animation frame', () => {
    let flush!: FrameRequestCallback;
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      flush = callback;
      return 1;
    });
    const first: LiveBarUpdate = {
      symbol: 'AAPL',
      timeframe: '15m',
      extended: true,
      asOf: 10,
      bar: { time: 1, open: 2, high: 2, low: 2, close: 2, volume: 10 },
    };
    const newest: LiveBarUpdate = { ...first, asOf: 11, bar: { ...first.bar, volume: 12 } };
    const other: LiveBarUpdate = {
      ...first,
      timeframe: '1h',
      asOf: 11,
      bar: { ...first.bar, volume: 4 },
    };
    stream.open.mockImplementation((_symbols: string[], options: QuoteStreamOptions) => {
      options.onBars?.([first, newest, other]);
      return vi.fn();
    });

    const { result } = renderHook(() => useQuoteStream(['AAPL']));
    act(() => flush(0));

    expect(result.current.bars.get('AAPL:15m:true')?.bar.volume).toBe(12);
    expect(result.current.bars.get('AAPL:1h:true')?.bar.volume).toBe(4);
  });
});
