import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useGreenlightData } from '@/features/greenlight/hooks/useGreenlightData';
import type { GreenlightState } from '@/features/greenlight/model/types';

afterEach(() => {
  vi.unstubAllGlobals();
});

const STORED: GreenlightState = {
  stats: { '2026-04-17': { Deliverable: { amount: 388, details: [] }, currency: 'USD' } },
  meta: null,
  markers: [],
  widgets: { '2026-04': ['vscode'] },
};

/** Fake KV endpoint. `readFails` makes the initial GET fail without breaking writes. */
function stubApi(options: { readFails?: boolean; writeDelayMs?: number } = {}) {
  let stored: GreenlightState = structuredClone(STORED);
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
    const api = stubApi({ writeDelayMs: 20 });
    const { result } = renderHook(() => useGreenlightData(), { wrapper });

    await waitFor(() => expect(result.current.state.widgets['2026-04']).toEqual(['vscode']));

    // Both calls start before either round trip resolves.
    await act(async () => {
      await Promise.all([
        result.current.toggleWidget({ monthKey: '2026-05', tool: 'vscode' }),
        result.current.toggleWidget({ monthKey: '2026-06', tool: 'cursor' }),
      ]);
    });

    expect(api.stored.widgets).toEqual({
      '2026-04': ['vscode'],
      '2026-05': ['vscode'],
      '2026-06': ['cursor'],
    });
  });

  it('keeps stats intact while toggling', async () => {
    const api = stubApi();
    const { result } = renderHook(() => useGreenlightData(), { wrapper });

    await waitFor(() => expect(result.current.state.stats['2026-04-17']).toBeDefined());
    await act(async () => {
      await result.current.toggleMarker('2026-04-17');
    });

    expect(api.stored.stats['2026-04-17']?.Deliverable.amount).toBe(388);
    expect(api.stored.markers).toEqual(['2026-04-17']);
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
