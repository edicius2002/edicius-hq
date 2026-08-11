import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useDiagramCamera } from '@/features/finance/hooks/useDiagramCamera';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function TestWrapper({ children }: { children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useDiagramCamera', () => {
  it('restores the last view after the canvas has unmounted', async () => {
    let stored: unknown = { version: 1, cameras: { cash: { x: -120, y: 48, zoom: 1.2 } } };
    const writes: unknown[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        if ((init?.method ?? 'GET') === 'PUT') {
          const body = JSON.parse(String(init?.body)) as { value: unknown };
          stored = body.value;
          writes.push(body.value);
          return Response.json({ key: 'finance-camera-views', value: stored });
        }
        return Response.json({ key: 'finance-camera-views', value: stored });
      }),
    );

    const first = renderHook(() => useDiagramCamera('cash'), { wrapper: TestWrapper });
    await waitFor(() => expect(first.result.current.isFetching).toBe(false));
    expect(first.result.current.camera).toEqual({ x: -120, y: 48, zoom: 1.2 });

    act(() => first.result.current.setCamera({ x: 70, y: -25, zoom: 0.8 }));
    expect(first.result.current.camera).toEqual({ x: 70, y: -25, zoom: 0.8 });

    // Leaving Finance flushes the debounce, so a refresh cannot lose its last view.
    await act(async () => window.dispatchEvent(new Event('pagehide')));
    await waitFor(() => expect(writes).toHaveLength(1));
    first.unmount();

    const second = renderHook(() => useDiagramCamera('cash'), { wrapper: TestWrapper });
    await waitFor(() => expect(second.result.current.isFetching).toBe(false));
    expect(second.result.current.camera).toEqual({ x: 70, y: -25, zoom: 0.8 });
  });
});
