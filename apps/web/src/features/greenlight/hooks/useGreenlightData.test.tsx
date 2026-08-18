import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGreenlightData } from '@/features/greenlight/hooks/useGreenlightData';
import type { GreenlightState } from '@/features/greenlight/model/types';

afterEach(() => {
  // Unmounted before the stub goes: leaving a hook mounted would let its
  // debounce fire into the next test, or into whatever `fetch` is by then.
  cleanup();
  vi.unstubAllGlobals();
});

const STORED: GreenlightState = {
  stats: { '2026-04-17': { Deliverable: { amount: 388, details: [] }, currency: 'USD' } },
  meta: null,
  markers: [],
  widgets: { '2026-04': ['vscode'] },
};

/** Fake KV endpoint. `readFails` makes the initial GET fail without breaking writes. */
function stubApi(
  options: { readFails?: boolean; writeDelayMs?: number; stored?: GreenlightState } = {},
) {
  let stored: GreenlightState = structuredClone(options.stored ?? STORED);
  const writes: GreenlightState[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const method = init?.method ?? 'GET';

      if (method === 'PUT') {
        const body = JSON.parse(String(init?.body)) as { value: GreenlightState };
        if (options.writeDelayMs) {
          await new Promise((resolve) => setTimeout(resolve, options.writeDelayMs));
        }
        stored = body.value;
        writes.push(structuredClone(body.value));
        return Response.json({ key: 'greenlight', value: body.value });
      }

      if (options.readFails) {
        return Response.json({ detail: 'boom' }, { status: 500 });
      }
      return Response.json({ key: 'greenlight', value: stored });
    }),
  );

  return {
    writes,
    get stored() {
      return stored;
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useGreenlightData storage sync', () => {
  it('does not lose a write when two toggles are fired back to back', async () => {
    const api = stubApi({
      writeDelayMs: 20,
      stored: {
        ...STORED,
        stats: {
          ...STORED.stats,
          '2026-05-16': { Deliverable: { amount: 390, details: [] }, currency: 'USD' },
          '2026-06-20': { Deliverable: { amount: 1950, details: [] }, currency: 'USD' },
        },
      },
    });
    const { result } = renderHook(() => useGreenlightData(), { wrapper });

    await waitFor(() => expect(result.current.state.widgets['2026-04']).toEqual(['vscode']));

    // Both calls start before either round trip resolves.
    await act(async () => {
      await Promise.all([
        result.current.toggleWidget({ monthKey: '2026-05', tool: 'vscode' }),
        result.current.toggleWidget({ monthKey: '2026-06', tool: 'cursor' }),
      ]);
    });

    // One write carries both, because neither toggle waited for the other's.
    await waitFor(() =>
      expect(api.stored.widgets).toEqual({
        '2026-04': ['vscode'],
        '2026-05': ['vscode'],
        '2026-06': ['cursor'],
      }),
    );
    expect(api.writes).toHaveLength(1);
  });

  it('keeps stats intact while toggling', async () => {
    const api = stubApi();
    const { result } = renderHook(() => useGreenlightData(), { wrapper });

    await waitFor(() => expect(result.current.state.stats['2026-04-17']).toBeDefined());
    await act(async () => {
      await result.current.toggleMarker('2026-04-17');
    });

    // The write leaves on a trailing debounce, so the marker reaches storage a
    // moment after it reaches the screen.
    await waitFor(() => expect(api.stored.markers).toEqual(['2026-04-13']));
    expect(api.stored.stats['2026-04-17']?.Deliverable.amount).toBe(388);
  });

  it('says that edits are held before it says they are saved', async () => {
    const api = stubApi();
    const { result } = renderHook(() => useGreenlightData(), { wrapper });

    await waitFor(() => expect(result.current.saveState).toBe('idle'));

    await act(async () => {
      await result.current.toggleMarker('2026-04-17');
    });

    expect(result.current.saveState).toBe('pending');
    expect(api.writes).toHaveLength(0);

    await waitFor(() => expect(result.current.saveState).toBe('saved'));
    expect(api.writes).toHaveLength(1);
  });

  it('refuses to write when the read failed, instead of overwriting stored data', async () => {
    const api = stubApi({ readFails: true });
    const { result } = renderHook(() => useGreenlightData(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));

    await expect(
      result.current.toggleWidget({ monthKey: '2026-05', tool: 'vscode' }),
    ).rejects.toThrow(/could not load/i);

    expect(api.writes).toHaveLength(0);
  });
});

/**
 * Importing a CSV is the only operation in this app that can destroy years of
 * data, and until now nothing exercised the destructive half of it.
 *
 * Verified by mutation before writing these: dropping the "keep weeks the CSV
 * does not mention" loop — which would replace the whole document with the
 * CSV — used to pass every test that did not import.
 */
describe('importing a CSV', () => {
  const OTHER_WEEK_DAY = '2026-04-17';

  /** One deliverable row, in the month the clock says we are in. */
  function csvForThisMonth(day = 15) {
    const now = new Date();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const date = `${now.getFullYear()}-${month}-${String(day).padStart(2, '0')}`;
    return {
      date,
      text: ['Date,Type,Amount,Currency', `${date},Deliverable,500,USD`].join('\n'),
    };
  }

  it('keeps weeks the CSV does not mention', async () => {
    const api = stubApi();
    const csv = csvForThisMonth();

    const { result } = renderHook(() => useGreenlightData(), { wrapper });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    await act(async () => {
      await result.current.importCsv({
        fileName: 'x.csv',
        content: csv.text,
      });
    });

    await waitFor(() => expect(Object.keys(api.stored.stats)).toContain(csv.date));
    expect(Object.keys(api.stored.stats)).toContain(OTHER_WEEK_DAY);
    expect(api.stored.stats[OTHER_WEEK_DAY]).toEqual(STORED.stats[OTHER_WEEK_DAY]);
    expect(api.stored.meta?.replaceMode).toBe('weeks');
  });

  it('seeds the whole document when there is nothing stored yet', async () => {
    // Replace all exists only as this empty-store seed: there is no history to
    // protect, so the CSV *is* the document. With data, the same function
    // rebuilds weeks instead — there is no longer a switch that can wipe them.
    const api = stubApi();
    api.stored.stats = {};
    const csv = csvForThisMonth();

    const { result } = renderHook(() => useGreenlightData(), { wrapper });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    await act(async () => {
      await result.current.importCsv({
        fileName: 'x.csv',
        content: csv.text,
      });
    });

    await waitFor(() => expect(Object.keys(api.stored.stats)).toEqual([csv.date]));
    expect(api.stored.meta?.replaceMode).toBe('all');
  });

  it('keeps the markers after a week rebuild', async () => {
    const api = stubApi();
    api.stored.markers = ['2026-04-13'];
    const csv = csvForThisMonth();

    const { result } = renderHook(() => useGreenlightData(), { wrapper });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    await act(async () => {
      await result.current.importCsv({
        fileName: 'x.csv',
        content: csv.text,
      });
    });

    await waitFor(() => expect(api.stored.meta?.fileName).toBe('x.csv'));
    expect(api.stored.markers).toEqual(['2026-04-13']);
  });
});

describe('reading damaged stored data', () => {
  /**
   * `stats` used to be taken whole on `typeof === 'object'`, so one malformed
   * day reached `toDayRows`, which reads `day.Deliverable.amount` unguarded.
   * That throws, and the boundary that catches it wraps the whole
   * `RouterProvider` — the app is replaced by an error screen with no
   * navigation, so there is no route to the Clear button that would fix it.
   */
  function stubStored(state: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'PUT') {
          return Response.json({ key: 'greenlight', value: JSON.parse(String(init?.body)).value });
        }
        return Response.json({ key: 'greenlight', value: state });
      }),
    );
  }

  it('drops a day it cannot read instead of taking the app down', async () => {
    stubStored({
      stats: {
        '2026-04-17': { Deliverable: { amount: 388, details: [] }, currency: 'USD' },
        '2026-04-18': null,
        '2026-04-19': { currency: 'USD' },
        '2026-04-20': { Deliverable: { amount: 'a lot' }, currency: 'USD' },
      },
      meta: null,
      markers: [],
      widgets: {},
    });

    const { result } = renderHook(() => useGreenlightData(), { wrapper });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    // The good day survives; the three unreadable ones are simply not there.
    expect(Object.keys(result.current.state.stats)).toEqual(['2026-04-17']);
  });

  it('repairs the parts of a day it can', async () => {
    stubStored({
      stats: { '2026-04-17': { Deliverable: { amount: 388 } } },
      meta: null,
      markers: [],
      widgets: {},
    });

    const { result } = renderHook(() => useGreenlightData(), { wrapper });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    // Missing details and a missing currency have obvious answers; a missing
    // amount does not, which is why that one drops the day instead.
    expect(result.current.state.stats['2026-04-17']).toEqual({
      Deliverable: { amount: 388, details: [] },
      currency: 'USD',
    });
  });

  it('drops a marker that is not a date string and maps a day onto its week', async () => {
    stubStored({
      stats: { '2026-05-16': { Deliverable: { amount: 390, details: [] }, currency: 'USD' } },
      meta: null,
      markers: ['2026-05-16', 42, null],
      widgets: {},
    });

    const { result } = renderHook(() => useGreenlightData(), { wrapper });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(result.current.state.markers).toEqual(['2026-05-11']);
  });

  it('drops a stored marker whose week is gone from stats', async () => {
    stubStored({
      stats: { '2026-04-17': { Deliverable: { amount: 388, details: [] }, currency: 'USD' } },
      meta: null,
      markers: ['2026-05-16'],
      widgets: {},
    });

    const { result } = renderHook(() => useGreenlightData(), { wrapper });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(result.current.state.markers).toEqual([]);
  });

  it('drops a widget whose month has no weeks with data', async () => {
    stubStored({
      stats: { '2026-04-17': { Deliverable: { amount: 388, details: [] }, currency: 'USD' } },
      meta: null,
      markers: [],
      widgets: { '2026-04': ['vscode'], '2026-05': ['cursor'] },
    });

    const { result } = renderHook(() => useGreenlightData(), { wrapper });
    await waitFor(() => expect(result.current.isFetching).toBe(false));

    expect(result.current.state.widgets).toEqual({ '2026-04': ['vscode'] });
  });
});
