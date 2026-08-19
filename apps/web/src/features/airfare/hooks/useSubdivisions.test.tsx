import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useSubdivisionCatalogue, useSubdivisions } from '@/features/airfare/hooks/useSubdivisions';

/**
 * Fetching the subdivisions of the countries in front of the reader, once
 * each, and only when asked.
 *
 * The zoom gate, the settle gate and the byte budget live in the map, where
 * the view is; what is proved here is the fourth of the four — a cache that
 * never expires — that a country with nothing to give is an answer rather than
 * a failure, and that a fan-out of several countries is several cacheable
 * requests rather than one uncacheable one.
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

const BOLIVIA = {
  country: '068',
  borders: {
    type: 'Topology',
    objects: { borders: { type: 'MultiLineString', arcs: [[0]] } },
    arcs: [
      [
        [-66, -16],
        [-64, -18],
      ],
    ],
  },
  labels: [{ name: 'Santa Cruz', at: [-62.5, -17.2], area: 0.0091 }],
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

const serving = (url: string) => {
  if (url.endsWith('/604')) return Response.json(PERU);
  if (url.endsWith('/068')) return Response.json(BOLIVIA);
  return new Response('null', { status: 404 });
};

describe('useSubdivisions', () => {
  it('asks for nothing at all until a country has been named', async () => {
    /*
     * The whole default view. `fetch` is left as `test/setup` leaves it — a
     * rejection — so a request here would fail the test loudly rather than
     * quietly hitting a real API.
     */
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisions([]), { wrapper });
    await waitFor(() => expect(result.current).toEqual([]));
  });

  it('fetches the country it was given and hands back something drawable', async () => {
    const calls = stub(serving);
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisions(['604']), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(calls[0]).toContain('/api/geography/subdivisions/604');
    expect(result.current[0].labels[0].name).toBe('Loreto');
    expect(result.current[0].borders?.coordinates).toHaveLength(1);
  });

  it('fetches every country in the view, one request each', async () => {
    /*
     * One query per country rather than one for the set. It is what makes the
     * next view cheap: two views over the same part of the world share most of
     * their countries, and a key per country means the second pays only for
     * what the first did not already have.
     */
    const calls = stub(serving);
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisions(['604', '068']), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(calls.filter((url) => url.includes('/604'))).toHaveLength(1);
    expect(calls.filter((url) => url.includes('/068'))).toHaveLength(1);
  });

  it('hands the countries back in the order they were asked for', async () => {
    // Which is the order the budget chose, biggest on screen first — and the
    // order the subdivision names then claim their ground in.
    const stubbed = stub(serving);
    expect(stubbed).toEqual([]);
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisions(['068', '604']), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(result.current.map((each) => each.country)).toEqual(['068', '604']);
  });

  it('keeps quiet about a country that has nothing to give', async () => {
    /*
     * The silent fallback, now that there are neighbours to be silent among. A
     * country Natural Earth does not divide simply is not in what comes back,
     * and the map's answer to that is the same as its answer to one still in
     * flight: keep the country's own name.
     */
    stub(serving);
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisions(['604', '732']), { wrapper });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].country).toBe('604');
  });

  it('adds a newly visible country without re-fetching the ones already held', async () => {
    /*
     * A pan is not a new view from scratch. This is what the byte budget is
     * spent against: the countries a view brings in that were not already in
     * hand.
     */
    const calls = stub(serving);
    const wrapper = makeWrapper();
    const held = { countries: ['604'] };
    const { result, rerender } = renderHook(() => useSubdivisions(held.countries), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    held.countries = ['604', '068'];
    rerender();
    await waitFor(() => expect(result.current).toHaveLength(2));
    expect(calls.filter((url) => url.includes('/604'))).toHaveLength(1);
  });

  it('never asks twice for a country it has already fetched', async () => {
    /*
     * Natural Earth publishes a few times a decade. A reader who zooms out of
     * Peru and back into it is looking at geometry that cannot have moved, so
     * the second look costs nothing — which is the fourth of the four things
     * damping this, and the one that matters over a long session.
     */
    const calls = stub(serving);
    const wrapper = makeWrapper();

    const first = renderHook(() => useSubdivisions(['604']), { wrapper });
    await waitFor(() => expect(first.result.current).toHaveLength(1));
    first.unmount();

    const second = renderHook(() => useSubdivisions(['604']), { wrapper });
    await waitFor(() => expect(second.result.current).toHaveLength(1));
    expect(calls).toHaveLength(1);
  });

  it('remembers a country that had nothing to give, rather than asking again', async () => {
    // Passing over Western Sahara twice is one 404, not one per visit.
    const calls = stub(() => new Response('null', { status: 404 }));
    const wrapper = makeWrapper();

    const first = renderHook(() => useSubdivisions(['732']), { wrapper });
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(first.result.current).toEqual([]);
    first.unmount();

    const second = renderHook(() => useSubdivisions(['732']), { wrapper });
    await waitFor(() => expect(second.result.current).toEqual([]));
    expect(calls).toHaveLength(1);
  });

  it('hands back the same array between renders while nothing has arrived', async () => {
    /*
     * Load-bearing, and easy to lose. The map keys its canvas work off this
     * array, so a new identity every render would repaint the globe twice a
     * frame for the whole of a drag — and the identity only survives because
     * `combine` is declared once at module scope rather than inline.
     */
    stub(serving);
    const wrapper = makeWrapper();
    const { result, rerender } = renderHook(() => useSubdivisions(['604']), { wrapper });
    await waitFor(() => expect(result.current).toHaveLength(1));

    const before = result.current;
    rerender();
    rerender();
    expect(result.current).toBe(before);
  });
});

describe('useSubdivisionCatalogue', () => {
  const CATALOGUE = { countries: { '604': 43085, '068': 20656 } };

  it('asks for nothing until the reader has come close enough to need it', async () => {
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisionCatalogue(false), { wrapper });
    await waitFor(() => expect(result.current.fetchStatus).toBe('idle'));
    expect(result.current.data).toBeUndefined();
  });

  it('hands back what every country weighs, so a view can be budgeted', async () => {
    const calls = stub(() => Response.json(CATALOGUE));
    const wrapper = makeWrapper();
    const { result } = renderHook(() => useSubdivisionCatalogue(true), { wrapper });

    await waitFor(() => expect(result.current.data).toBeTruthy());
    expect(calls[0]).toContain('/api/geography/subdivisions');
    expect(result.current.data?.['604']).toBe(43085);
  });

  it('fetches the index once and never again', async () => {
    const calls = stub(() => Response.json(CATALOGUE));
    const wrapper = makeWrapper();

    const first = renderHook(() => useSubdivisionCatalogue(true), { wrapper });
    await waitFor(() => expect(first.result.current.data).toBeTruthy());
    first.unmount();

    const second = renderHook(() => useSubdivisionCatalogue(true), { wrapper });
    await waitFor(() => expect(second.result.current.data).toBeTruthy());
    expect(calls).toHaveLength(1);
  });
});
