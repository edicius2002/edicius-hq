import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { quoteBus } from '@/features/investing/data/quoteBus';
import { alertSoundPlayer } from '@/features/investing/lib/alertSound';
import { toastBus } from '@/shared/ui/toastBus';
import type { Quote } from '@/shared/api/market';

import { PriceAlertsWatcher } from './PriceAlertsWatcher';

function quote(over: Partial<Quote> = {}): Quote {
  return {
    symbol: 'AAPL',
    price: 200,
    currency: 'USD',
    previousClose: 200,
    change: 0,
    changePercent: 0,
    provider: 'test',
    time: 0,
    marketState: 'REGULAR',
    name: 'Apple',
    extended: false,
    ...over,
  };
}

function drainToasts(): void {
  let current: { id: string }[] = [];
  const unsubscribe = toastBus.subscribe((toasts) => {
    current = toasts;
  });
  unsubscribe();
  for (const toast of current) toastBus.dismiss(toast.id);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  drainToasts();
});

/** One active alert already stored — bypasses `usePriceAlerts().add` so the id is known. */
function stubStoredAlert() {
  const rules = {
    version: 1,
    alerts: [
      {
        id: 'a1',
        symbol: 'AAPL',
        kind: 'buy',
        price: 200,
        active: true,
        createdAt: 0,
        triggeredAt: null,
      },
    ],
  };
  const writes: unknown[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/api/kv/alert-rules')) {
        if ((init?.method ?? 'GET') === 'PUT') {
          writes.push(JSON.parse(String(init?.body)).value);
          return Response.json({ key: 'alert-rules', value: rules });
        }
        return Response.json({ key: 'alert-rules', value: rules });
      }
      return new Response(null, { status: 404 });
    }),
  );

  return { writes };
}

function renderWatcher() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  render(<PriceAlertsWatcher />, { wrapper });
  return client;
}

/**
 * The alert-quotes query only turns on once `usePriceAlerts` has hydrated the
 * stored rule and `activeAlertSymbols` is non-empty — that hydration is its
 * own async KV read, so the very first quote fetch is not synchronous with
 * mount. Every call site waits for a specific call count on the `quoteBus`
 * spy rather than assuming a fetch has landed, the same way the rest of the
 * suite waits on an observable effect instead of a fixed delay.
 */
async function waitForQuotesCall(spy: ReturnType<typeof vi.spyOn>, times: number) {
  await waitFor(() => expect(spy).toHaveBeenCalledTimes(times));
}

async function forceRefetch(client: QueryClient) {
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['market', 'alert-quotes'] });
  });
}

describe('PriceAlertsWatcher', () => {
  it('fires a toast and a buy tone on a genuine crossing, and persists the trigger', async () => {
    const api = stubStoredAlert();
    const soundSpy = vi.spyOn(alertSoundPlayer, 'play');

    // First reading: 210, unmet for a buy at 200 — only seeds the tracked side.
    const quotesSpy = vi
      .spyOn(quoteBus, 'quotes')
      .mockResolvedValueOnce({ quotes: [quote({ price: 210 })], failed: [] })
      .mockResolvedValueOnce({ quotes: [quote({ price: 195 })], failed: [] });

    const client = renderWatcher();
    // The query only turns on once the stored alert has hydrated, so this
    // first call is the automatic one — nothing forces it.
    await waitForQuotesCall(quotesSpy, 1);
    expect(soundSpy).not.toHaveBeenCalled();

    // Second reading crosses down through 200 — this is the fire.
    await forceRefetch(client);
    await waitForQuotesCall(quotesSpy, 2);

    await waitFor(() => expect(soundSpy).toHaveBeenCalledWith('buy'));
    await waitFor(() => {
      const last = api.writes.at(-1) as {
        alerts: { active: boolean; triggeredAt: number | null }[];
      };
      expect(last.alerts[0]).toMatchObject({ active: false });
      expect(last.alerts[0].triggeredAt).not.toBeNull();
    });

    quotesSpy.mockRestore();
  });

  it('ignores an extended-hours print — a crossing there waits for the next regular one', async () => {
    stubStoredAlert();
    const soundSpy = vi.spyOn(alertSoundPlayer, 'play');

    const quotesSpy = vi
      .spyOn(quoteBus, 'quotes')
      // Seed unmet at the regular price.
      .mockResolvedValueOnce({
        quotes: [quote({ price: 210, marketState: 'REGULAR' })],
        failed: [],
      })
      // A pre-market print already past the threshold — must not fire.
      .mockResolvedValueOnce({
        quotes: [quote({ price: 190, marketState: 'PRE', extended: true })],
        failed: [],
      })
      // The regular session resumes exactly where it left off — this now fires.
      .mockResolvedValueOnce({
        quotes: [quote({ price: 195, marketState: 'REGULAR' })],
        failed: [],
      });

    const client = renderWatcher();
    await waitForQuotesCall(quotesSpy, 1);

    await forceRefetch(client);
    await waitForQuotesCall(quotesSpy, 2);
    expect(soundSpy).not.toHaveBeenCalled();

    await forceRefetch(client);
    await waitForQuotesCall(quotesSpy, 3);
    await waitFor(() => expect(soundSpy).toHaveBeenCalledWith('buy'));

    quotesSpy.mockRestore();
  });

  it('fires on the first regular reading when the target crossed overnight, market closed at creation', async () => {
    stubStoredAlert();
    const soundSpy = vi.spyOn(alertSoundPlayer, 'play');

    const quotesSpy = vi
      .spyOn(quoteBus, 'quotes')
      // The market is closed: a stale last read, unmet for a buy at 200,
      // carrying yesterday's regular close as `previousClose`.
      .mockResolvedValueOnce({
        quotes: [quote({ price: 210, previousClose: 210, marketState: 'CLOSED' })],
        failed: [],
      })
      // The regular session opens with the price already through 200 — a
      // crossing that happened overnight, never observed live until now.
      .mockResolvedValueOnce({
        quotes: [quote({ price: 195, previousClose: 210, marketState: 'REGULAR' })],
        failed: [],
      });

    const client = renderWatcher();
    await waitForQuotesCall(quotesSpy, 1);
    expect(soundSpy).not.toHaveBeenCalled();

    await forceRefetch(client);
    await waitForQuotesCall(quotesSpy, 2);
    await waitFor(() => expect(soundSpy).toHaveBeenCalledWith('buy'));

    quotesSpy.mockRestore();
  });

  it('does not fire at the open when the target never crossed overnight, market closed at creation', async () => {
    stubStoredAlert();
    const soundSpy = vi.spyOn(alertSoundPlayer, 'play');

    const quotesSpy = vi
      .spyOn(quoteBus, 'quotes')
      .mockResolvedValueOnce({
        quotes: [quote({ price: 210, previousClose: 210, marketState: 'CLOSED' })],
        failed: [],
      })
      // Opens still above 200 — nothing to fire on.
      .mockResolvedValueOnce({
        quotes: [quote({ price: 205, previousClose: 210, marketState: 'REGULAR' })],
        failed: [],
      });

    const client = renderWatcher();
    await waitForQuotesCall(quotesSpy, 1);

    await forceRefetch(client);
    await waitForQuotesCall(quotesSpy, 2);
    expect(soundSpy).not.toHaveBeenCalled();

    quotesSpy.mockRestore();
  });
});
