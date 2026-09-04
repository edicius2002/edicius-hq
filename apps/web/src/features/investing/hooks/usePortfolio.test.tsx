import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePortfolio } from '@/features/investing/hooks/usePortfolio';
import { stubKvStore } from '@/test/kvStore';
import { queryWrapper } from '@/test/queryWrapper';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrapper = queryWrapper();

const stubPortfolio = (initial: unknown) => stubKvStore({ key: 'portfolio', initial });

describe('usePortfolio storage sync', () => {
  it('hydrates positions and persists adds, edits, and removals', async () => {
    const api = stubPortfolio({
      version: 1,
      positions: [{ symbol: 'AAPL', quantity: 1, averageCost: 100 }],
    });
    const { result } = renderHook(() => usePortfolio(), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.portfolio.positions).toEqual([
      { symbol: 'AAPL', quantity: 1, averageCost: 100 },
    ]);

    await act(async () => {
      await result.current.set('msft', 2, 400);
    });
    expect(result.current.portfolio.positions).toEqual([
      { symbol: 'AAPL', quantity: 1, averageCost: 100 },
      { symbol: 'MSFT', quantity: 2, averageCost: 400 },
    ]);
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(api.stored).toEqual(result.current.portfolio));

    await act(async () => {
      await result.current.set('aapl', 1.5, 120);
    });
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() =>
      expect(api.stored).toEqual({
        version: 1,
        positions: [
          { symbol: 'AAPL', quantity: 1.5, averageCost: 120 },
          { symbol: 'MSFT', quantity: 2, averageCost: 400 },
        ],
      }),
    );

    await act(async () => {
      await result.current.remove('MSFT');
    });
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() =>
      expect(api.stored).toEqual({
        version: 1,
        positions: [{ symbol: 'AAPL', quantity: 1.5, averageCost: 120 }],
      }),
    );
    expect(api.writes).toHaveLength(3);
  });
});
