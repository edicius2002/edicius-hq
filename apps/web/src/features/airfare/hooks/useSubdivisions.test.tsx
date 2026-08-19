import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSubdivisions } from '@/features/airfare/hooks/useSubdivisions';

/**
 * Fetching one country's subdivisions, once, and only when asked.
 *
 * The zoom and settle gates live in the map, where the view is; what is proved
 * here is the third of the three — a cache that never expires — and that a
 * country with nothing to give is an answer rather than a failure.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const PERU = {
  country: '604',
  borders: {
    type: 'Topology',
    objects: { borders: { type: 'MultiLineString', arcs: [[0]] } },
    arcs: [
      [
        [-76, -6],
        [-74, -8],
      ],
    ],
  },
  labels: [{ name: 'Loreto', at: [-74.4242, -4.0942], area: 0.0092493 }],
};

/**
 * One client for the whole test, not one per render.
 *
 * A fresh client per `renderHook` would make every cache assertion below pass
 * for the wrong reason — there would be nothing to hit.
 */
function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return wrapper;
}

function stub(answer: (url: string) => Response) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(answer(String(input)));
    }),
  );
  return calls;
}

describe('useSubdivisions', () => {
  it('asks for nothing at all until a country has been named', async () => {
    /*
     * The whole default view. `fetch` is left as `test/setup` leaves it — a
     * rejection — so a request here would fail the test loudly rather than
     * quietly hitting a real API.
     */
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisions(null), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(result.current.data).toBeUndefined();
  });

  it('fetches the country it was given and hands back something drawable', async () => {
    const calls = stub(() => Response.json(PERU));
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisions('604'), { wrapper });

    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(calls[0]).toContain('/api/geography/subdivisions/604');
    expect(result.current.data?.labels[0].name).toBe('Loreto');
    expect(result.current.data?.borders?.coordinates).toHaveLength(1);
  });

  it('never asks twice for a country it has already fetched', async () => {
    /*
     * Natural Earth publishes a few times a decade. A reader who zooms out of
     * Peru and back into it is looking at geometry that cannot have moved, so
     * the second look costs nothing — which is the third of the three things
     * damping this, and the one that matters over a long session.
     */
    const calls = stub(() => Response.json(PERU));
    const wrapper = makeWrapper();

    const first = renderHook(() => useSubdivisions('604'), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeTruthy());
    first.unmount();

    const second = renderHook(() => useSubdivisions('604'), { wrapper });
    await waitFor(() => expect(second.result.current.data).toBeTruthy());
    expect(calls).toHaveLength(1);
  });

  it('remembers a country that had nothing to give, rather than asking again', async () => {
    // The silent fallback, cached. Passing over Western Sahara twice is one
    // 404, not one per visit.
    const calls = stub(() => new Response('null', { status: 404 }));
    const wrapper = makeWrapper();

    const first = renderHook(() => useSubdivisions('732'), { wrapper });
    await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
    expect(first.result.current.data).toBeNull();
    expect(first.result.current.isError).toBe(false);
    first.unmount();

    const second = renderHook(() => useSubdivisions('732'), { wrapper });
    await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
    expect(calls).toHaveLength(1);
  });

  it('reports a real failure rather than swallowing it as an empty country', async () => {
    /*
     * The 404 is swallowed because it is an answer. A 500 from our own API is
     * a bug, and drawing nothing would be the map hiding it — the caller is
     * still free to keep quiet about it, but it has to be told.
     */
    stub(() => new Response('{"detail":"boom"}', { status: 500 }));
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisions('604'), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
