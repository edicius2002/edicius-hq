import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('@/features/investing/data/supabaseMarket', () => ({ openChartFocus: transport.open }));

import { CHART_FOCUS_HEARTBEAT_MS, useChartFocus } from './useChartFocus';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  transport.open.mockReset();
});

function publisher() {
  return {
    publish: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

describe('useChartFocus', () => {
  it('releases a hidden chart and resumes live bars when it becomes visible', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const first = publisher();
    const resumed = publisher();
    transport.open.mockResolvedValueOnce(first).mockResolvedValueOnce(resumed);
    const { unmount } = renderHook(() =>
      useChartFocus({ symbol: 'AAPL', timeframe: '1m', extended: false }),
    );
    await act(async () => void (await Promise.resolve()));
    expect(first.publish).toHaveBeenCalledWith(expect.objectContaining({ active: true }));

    visibility.mockReturnValue('hidden');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => void (await Promise.resolve()));
    expect(first.publish).toHaveBeenLastCalledWith(expect.objectContaining({ active: false }));
    expect(first.close).toHaveBeenCalledOnce();

    visibility.mockReturnValue('visible');
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    await act(async () => void (await Promise.resolve()));
    expect(resumed.publish).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
    unmount();
  });

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
    expect(old.publish.mock.calls[0][0].clientId).not.toBe(next.publish.mock.calls[0][0].clientId);
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

  it('retries an initial focus failure while the same chart stays selected', async () => {
    vi.useFakeTimers();
    const joined = publisher();
    transport.open.mockRejectedValueOnce(new Error('temporary')).mockResolvedValueOnce(joined);
    renderHook(() => useChartFocus({ symbol: 'AAPL', timeframe: '1m', extended: false }));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(transport.open).toHaveBeenCalledTimes(2);
    expect(joined.publish).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: 'AAPL', active: true }),
    );
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

  it('reopens focus after an active heartbeat publish fails', async () => {
    vi.useFakeTimers();
    const first = publisher();
    const second = publisher();
    first.publish.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('socket lost'));
    transport.open.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    renderHook(() => useChartFocus({ symbol: 'AAPL', timeframe: '1m', extended: false }));
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CHART_FOCUS_HEARTBEAT_MS);
    });
    expect(first.close).toHaveBeenCalledOnce();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(transport.open).toHaveBeenCalledTimes(2);
    expect(second.publish).toHaveBeenCalledWith(expect.objectContaining({ active: true }));
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
