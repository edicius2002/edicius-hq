import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { usePriceAlerts } from '@/features/investing/hooks/usePriceAlerts';
import type { AlertRules } from '@/features/investing/data/priceAlerts';
import { stubKvStore } from '@/test/kvStore';
import { queryWrapper } from '@/test/queryWrapper';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const wrapper = queryWrapper();

const stubAlertRules = (initial: AlertRules) => stubKvStore({ key: 'alert-rules', initial });

describe('usePriceAlerts storage sync', () => {
  it('hydrates alerts and persists an add, an edit, a toggle, and a trigger', async () => {
    const api = stubAlertRules({ version: 1, alerts: [] });
    const { result } = renderHook(() => usePriceAlerts(), { wrapper });

    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.alerts).toEqual([]);

    await act(async () => {
      await result.current.add({ symbol: 'aapl', kind: 'buy', price: 200 });
    });
    expect(result.current.alerts).toHaveLength(1);
    const [added] = result.current.alerts;
    expect(added).toMatchObject({ symbol: 'AAPL', kind: 'buy', price: 200, active: true });
    expect(typeof added.id).toBe('string');

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(api.stored.alerts).toHaveLength(1));

    await act(async () => {
      await result.current.update(added.id, { price: 210 });
    });
    await waitFor(() => expect(result.current.alerts[0].price).toBe(210));

    await act(async () => {
      await result.current.toggle(added.id, false);
    });
    await waitFor(() => expect(result.current.alerts[0].active).toBe(false));

    await act(async () => {
      await result.current.trigger(added.id, 5000);
    });
    await waitFor(() =>
      expect(result.current.alerts[0]).toMatchObject({ active: false, triggeredAt: 5000 }),
    );

    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() =>
      expect(api.stored.alerts[0]).toMatchObject({
        symbol: 'AAPL',
        price: 210,
        active: false,
        triggeredAt: 5000,
      }),
    );

    await act(async () => {
      await result.current.remove(added.id);
    });
    expect(result.current.alerts).toEqual([]);
    window.dispatchEvent(new Event('pagehide'));
    await waitFor(() => expect(api.stored.alerts).toEqual([]));
  });
});
