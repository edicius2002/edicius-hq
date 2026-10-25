import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const publisher = vi.hoisted(() => ({
  publish: vi.fn().mockResolvedValue(undefined),
  close: vi.fn().mockResolvedValue(undefined),
}));
const openMarketInterest = vi.hoisted(() => vi.fn().mockResolvedValue(publisher));

vi.mock('@/features/investing/data/supabaseMarket', () => ({ openMarketInterest }));

import { MARKET_INTEREST_HEARTBEAT_MS, useMarketInterest } from './useMarketInterest';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

it('keeps the same market lease when symbols are only reordered', async () => {
  const { rerender, unmount } = renderHook(({ symbols }) => useMarketInterest(true, symbols), {
    initialProps: { symbols: ['AAPL', 'MSFT'] },
  });
  await act(async () => void (await Promise.resolve()));
  expect(openMarketInterest).toHaveBeenCalledTimes(1);
  publisher.publish.mockClear();
  publisher.close.mockClear();

  rerender({ symbols: ['MSFT', 'AAPL'] });
  await act(async () => void (await Promise.resolve()));

  expect(openMarketInterest).toHaveBeenCalledTimes(1);
  expect(publisher.publish).not.toHaveBeenCalled();
  expect(publisher.close).not.toHaveBeenCalled();
  unmount();
});

it('leases only visible symbols while the investing page needs live quotes', async () => {
  vi.useFakeTimers();
  const { result, rerender, unmount } = renderHook(
    ({ active, symbols }) => useMarketInterest(active, symbols),
    { initialProps: { active: false, symbols: ['AAPL', 'MSFT'] } },
  );
  expect(result.current).toBe(false);
  expect(openMarketInterest).not.toHaveBeenCalled();

  rerender({ active: true, symbols: ['AAPL', 'MSFT'] });
  await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  expect(result.current).toBe(true);
  expect(publisher.publish).toHaveBeenCalledWith({
    clientId: expect.any(String),
    active: true,
    symbols: ['AAPL', 'MSFT'],
  });

  await act(async () => void (await vi.advanceTimersByTimeAsync(MARKET_INTEREST_HEARTBEAT_MS)));
  expect(publisher.publish).toHaveBeenCalledTimes(2);

  rerender({ active: true, symbols: ['AAPL'] });
  await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  expect(publisher.publish).toHaveBeenCalledWith({
    clientId: expect.any(String),
    active: true,
    symbols: ['AAPL'],
  });

  unmount();
  await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
  expect(publisher.publish).toHaveBeenLastCalledWith({
    clientId: expect.any(String),
    active: false,
  });
  expect(publisher.close).toHaveBeenCalledTimes(2);
});

it('releases the lease when the tab is hidden and renews it when shown', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const { result, unmount } = renderHook(() => useMarketInterest(true, ['AAPL']));
  await act(async () => void (await Promise.resolve()));
  expect(result.current).toBe(true);

  visibility.mockReturnValue('hidden');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => void (await Promise.resolve()));
  expect(result.current).toBe(false);
  expect(publisher.publish).toHaveBeenLastCalledWith({
    clientId: expect.any(String),
    active: false,
  });

  visibility.mockReturnValue('visible');
  act(() => document.dispatchEvent(new Event('visibilitychange')));
  await act(async () => void (await Promise.resolve()));
  expect(result.current).toBe(true);
  expect(openMarketInterest).toHaveBeenCalledTimes(2);
  unmount();
});
