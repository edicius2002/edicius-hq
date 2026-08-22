import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useFareSpend } from '@/features/airfare/hooks/useFareSpend';

/**
 * How the day's spend stays current — `spend-is-read-back-not-only-written`.
 *
 * The thing worth pinning here is that it is asked for on its own timer rather
 * than carried on the collection stream. That stream exists only while a pass
 * runs and is opened by a row that pressed, so every pass it could report is one
 * somebody was already watching; the passes this figure exists for are the
 * ninety-six a scheduler runs with the page shut.
 */

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SPEND = {
  day: '2026-08-21',
  resetsAt: '2026-08-22T00:00:00+00:00',
  spent: 150,
  ceiling: null,
  remaining: null,
  busiestOnRecord: 329,
  kinds: [{ kind: 'board', requests: 150 }],
};

function answer(body: unknown) {
  const fetcher = vi.fn().mockResolvedValue(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function wrap(queryClient: QueryClient) {
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe('useFareSpend', () => {
  it('asks the spend endpoint and hands back the day as it stands', async () => {
    const fetcher = answer(SPEND);
    const { result } = renderHook(() => useFareSpend(), { wrapper: wrap(client()) });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(String(fetcher.mock.calls[0][0])).toContain('/api/fares/spend');
    expect(result.current.data?.spent).toBe(150);
    expect(result.current.data?.busiestOnRecord).toBe(329);
  });

  it('carries an unreadable ledger through as null rather than as zero', async () => {
    // The one transformation this hook must never make. A day whose spend
    // cannot be established is one the collector treats as fully spent, so a
    // zero here would draw a stopped collector as a quiet morning.
    answer({ ...SPEND, spent: null, remaining: 0, kinds: [] });
    const { result } = renderHook(() => useFareSpend(), { wrapper: wrap(client()) });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(result.current.data?.spent).toBeNull();
    expect(result.current.data?.remaining).toBe(0);
  });

  it('reads the file again on a fresh mount rather than serving the cache', async () => {
    // Against the app-wide 30-second `staleTime`. The whole value of this
    // readout is that it is current when somebody looks at it, and the call is
    // ~200 bytes off a local file with no upstream in it.
    const fetcher = answer(SPEND);
    const shared = client();

    const first = renderHook(() => useFareSpend(), { wrapper: wrap(shared) });
    await waitFor(() => expect(first.result.current.data).toBeDefined());
    first.unmount();

    const second = renderHook(() => useFareSpend(), { wrapper: wrap(shared) });
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(second.result.current.data?.spent).toBe(150);
  });

  it('asks again a minute later, without anything having been pressed', async () => {
    // The scheduler runs a pass every fifteen minutes with nobody watching. A
    // figure that only moved when a row pressed would be freshest exactly when
    // it mattered least.
    vi.useFakeTimers();
    const fetcher = answer(SPEND);
    const { result } = renderHook(() => useFareSpend(), { wrapper: wrap(client()) });

    await vi.waitFor(() => expect(result.current.data).toBeDefined());
    expect(fetcher).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  });
});
