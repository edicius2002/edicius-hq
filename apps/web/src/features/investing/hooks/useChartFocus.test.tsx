import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/features/investing/data/supabaseMarket', () => ({ openChartFocus: transport.open }));

import { CHART_FOCUS_HEARTBEAT_MS, useChartFocus } from './useChartFocus';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

function publisher() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('useChartFocus', () => {
  it('sends immediately and every fifteen seconds on one publisher', async () => {
    vi.useFakeTimers();
    const joined = publisher();
    transport.open.mockResolvedValue(joined);
    const { unmount } = renderHook(() =>
      useChartFocus({ symbol: 'AAPL', timeframe: '15m', extended: true }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(joined.publish).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'AAPL', active: true }),
    );
    expect(joined.publish).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHART_FOCUS_HEARTBEAT_MS);
    });
    expect(joined.publish).toHaveBeenCalledTimes(2);
    unmount();
    expect(joined.publish).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(joined.close).toHaveBeenCalledOnce();
  });

  it('releases the old focus and immediately advertises changed selection', async () => {
    vi.useFakeTimers();
    const old = publisher();
    const next = publisher();
    transport.open.mockResolvedValueOnce(old).mockResolvedValueOnce(next);
    const { rerender } = renderHook(
      ({ symbol, timeframe, extended }) => useChartFocus({ symbol, timeframe, extended }),
      {
        initialProps: { symbol: 'AAPL', timeframe: '15m', extended: false },
      },
    );
    await act(async () => {
      await Promise.resolve();
    });
    rerender({ symbol: 'MSFT', timeframe: '1h', extended: true });
    await act(async () => {
      await Promise.resolve();
    });

    expect(old.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ symbol: 'AAPL', active: false }),
    );
    expect(old.close).toHaveBeenCalledOnce();
    expect(next.publish).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'MSFT', timeframe: '1h', extended: true, active: true }),
    );
  });

  it('does not leak a late channel when session lookup fails or resolves after unmount', async () => {
    transport.open.mockRejectedValueOnce(new Error('session failure'));
    const first = renderHook(() =>
      useChartFocus({ symbol: 'AAPL', timeframe: '1d', extended: false }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    first.unmount();

    let resolve!: (value: ReturnType<typeof publisher>) => void;
    transport.open.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    const late = publisher();
    const second = renderHook(() =>
      useChartFocus({ symbol: 'AAPL', timeframe: '1d', extended: false }),
    );
    second.unmount();
    resolve(late);
    await act(async () => {
      await Promise.resolve();
    });
    expect(late.publish).not.toHaveBeenCalled();
    expect(late.close).toHaveBeenCalledOnce();
  });

  it('swallows focus send failures so they do not escape through React', async () => {
    const joined = publisher();
    joined.publish.mockRejectedValue(new Error('send failed'));
    transport.open.mockResolvedValue(joined);
    const { unmount } = renderHook(() =>
      useChartFocus({ symbol: 'AAPL', timeframe: '1m', extended: false }),
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(joined.publish).toHaveBeenCalledOnce();
    unmount();
    await act(async () => {
      await Promise.resolve();
    });
    expect(joined.close).toHaveBeenCalledOnce();
  });

  it('waits for the inactive release attempt to settle before closing the channel', async () => {
    let finishRelease!: () => void;
    const joined = publisher();
    joined.publish.mockImplementation((focus) =>
      focus.active
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            finishRelease = resolve;
          }),
    );
    transport.open.mockResolvedValue(joined);
    const { unmount } = renderHook(() =>
      useChartFocus({ symbol: 'AAPL', timeframe: '15m', extended: false }),
    );
    await act(async () => {
      await Promise.resolve();
    });

    unmount();

    expect(joined.publish).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    expect(joined.close).not.toHaveBeenCalled();
    await act(async () => {
      finishRelease();
      await Promise.resolve();
    });
    expect(joined.close).toHaveBeenCalledOnce();
  });
});
