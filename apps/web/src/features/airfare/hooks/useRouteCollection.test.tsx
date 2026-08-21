import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useRouteCollection } from '@/features/airfare/hooks/useRouteCollection';
import type { FareHistoryResponse, FareSnapshot } from '@/shared/api/fares';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  FakeEventSource.opened = [];
});

/**
 * The stream the rows follow a pass on — `a-pass-is-pushed-not-polled`.
 *
 * Installed as the global rather than injected through the hook's own seam,
 * because the seam a browser uses is the global and a test that bypassed it
 * would not be testing the thing that runs. `setup.ts` already puts an inert
 * `EventSource` in jsdom for pages that merely mount; this replaces it with one
 * a test can talk through.
 */
class FakeEventSource {
  /** Every source opened in this test, oldest first. */
  static opened: FakeEventSource[] = [];

  readonly url: string;
  closed = false;
  private readonly listeners = new Map<string, (event: Event) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.opened.push(this);
  }

  addEventListener(type: string, handler: (event: Event) => void) {
    this.listeners.set(type, handler);
  }

  removeEventListener(type: string) {
    this.listeners.delete(type);
  }

  close() {
    this.closed = true;
  }

  /** A named frame, or a bare event where the browser sends no data. */
  emit(type: string, data?: unknown) {
    this.listeners.get(type)?.(
      data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) }),
    );
  }
}

function streamed(): FakeEventSource {
  const source = FakeEventSource.opened.at(-1);
  if (!source) throw new Error('no stream was opened');
  return source;
}

const LIM_CUZ: FareRoute = {
  origin: 'LIM',
  destination: 'CUZ',
  month: '2026-10',
  currency: 'USD',
};

const LIM_MAD: FareRoute = {
  origin: 'LIM',
  destination: 'MAD',
  month: '2026-12',
  currency: 'USD',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** One finished collection pass over one watched month, as the server reports it. */
function passOver(route: FareRoute, overrides: Record<string, unknown> = {}) {
  return {
    state: 'finished',
    startedAt: '2026-08-19T14:00:00+00:00',
    finishedAt: '2026-08-19T14:00:01+00:00',
    source: 'google',
    watching: [`${route.origin}-${route.destination} ${route.month}`],
    polling: 1,
    completed: 1,
    collected: 1,
    changed: 1,
    failed: 0,
    skipped: [],
    error: null,
    results: [
      {
        origin: route.origin,
        destination: route.destination,
        // One departure inside the watched month. A pass over a month reports
        // one of these per day it actually polled.
        flightDate: `${route.month}-09`,
        returnDate: null,
        ok: true,
        changed: true,
        seeded: 0,
        offers: 9,
        cheapest: 380,
        currency: 'USD',
        errorCode: null,
        errorMessage: null,
        ...overrides,
      },
    ],
  };
}

/**
 * A collect endpoint that answers when it is told to.
 *
 * Held open on purpose: the in-flight state is the thing under test, and a
 * `fetch` that resolves immediately never lets a test see it. `setup.ts` makes
 * an unstubbed `fetch` reject, so nothing here can reach the network by
 * accident.
 */
function stubCollect() {
  const calls: unknown[] = [];
  let release: ((value: Response) => void) | null = null;

  vi.stubGlobal(
    'fetch',
    vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body)));
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    }),
  );

  return {
    calls,
    answer(body: unknown) {
      release?.(Response.json(body));
    },
  };
}

/**
 * A press that starts a pass, and a stream the test drives by hand.
 *
 * `progress` is what the *fallback* poll would answer if the stream ever falls
 * over: the two calls are the same URL by design — one document describes a
 * pass whether or not it has finished — so they are told apart by method. Each
 * `GET` takes the next answer in the list and the last one repeats, so a test
 * says how the pass unfolds and not how many times the hook is allowed to look.
 */
function stubPassInProgress(started: unknown, progress: unknown[] = []) {
  const polls: number[] = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') return Response.json(started);
      const next = progress[Math.min(polls.length, progress.length - 1)];
      polls.push(1);
      return Response.json(next);
    }),
  );
  return { polls };
}

/** One board snapshot, as the stream pushes it and as `/history` returns it. */
function snapshotOf(route: FareRoute, capturedAt: string, price = 380): FareSnapshot {
  return {
    capturedAt,
    source: 'google-flights',
    origin: route.origin,
    destination: route.destination,
    flightDate: `${route.month}-09`,
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers: [
      {
        airline: 'LA',
        airlineName: 'LATAM',
        flightNumber: 'LA600',
        departureAt: `${route.month}-09T08:00`,
        arrivalAt: `${route.month}-09T10:00`,
        transfers: 0,
        durationMinutes: 120,
        price,
        currency: 'USD',
      },
    ],
  };
}

/** An archive the charts are already drawn from, with one observation in it. */
function historyOf(route: FareRoute): FareHistoryResponse {
  return {
    origin: route.origin,
    destination: route.destination,
    snapshots: [snapshotOf(route, '2026-08-19T13:00:00+00:00', 400)],
    baseline: [{ flightDate: `${route.month}-09`, date: '2026-08-01', price: 410 }],
    health: { lastCheckedAt: '2026-08-19T13:00:00+00:00', checks: 1, changes: 1, errors: 0 },
    airports: [],
  };
}

/** A pass that has started and not finished. */
function passRunning(route: FareRoute, overrides: Record<string, unknown> = {}) {
  return {
    ...passOver(route),
    state: 'running',
    finishedAt: null,
    polling: 31,
    completed: 0,
    results: [],
    ...overrides,
  };
}

describe('collecting one watched route from its own row', () => {
  it('asks for that route alone, month and currency included', async () => {
    // The bulk button sends the whole collectable list; a row press must send
    // one month, or pressing it would spend the request budget on eight others.
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_MAD));

    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(api.calls[0]).toEqual({
      routes: [
        {
          origin: 'LIM',
          destination: 'MAD',
          month: '2026-12',
          currency: 'USD',
        },
      ],
    });
  });

  it('sends a city pair, a month and a currency, and no reading preference', async () => {
    /*
     * The body used to carry `focusDate` beside the month, which was the one
     * reading preference this client ever sent a collector — 12.134, and gone
     * with 12.266. A press still buys up to thirty-one departures and a pass
     * can still truncate at the request budget, and which departure survives
     * that is the nearest one: 12.111, which is the rule the focus was jumping
     * ahead of.
     *
     * Asserted on the keys rather than on the whole body, because a
     * `focusDate: undefined` would serialise away here while still being the
     * shape that reaches a stored document as a key.
     */
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_MAD));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    expect(Object.keys((api.calls[0] as { routes: object[] }).routes[0])).toEqual([
      'origin',
      'destination',
      'month',
      'currency',
    ]);
  });

  it('marks only the pressed row as working', async () => {
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    await waitFor(() => expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]));
    expect(result.current.collecting).not.toContain(routeId(LIM_MAD));

    await act(async () => {
      api.answer(passOver(LIM_CUZ));
    });
    await waitFor(() => expect(result.current.collecting).toEqual([]));
  });

  it('refuses a second press of a row that is already collecting', async () => {
    /*
     * The disabled button stops a human double-click, which is several renders
     * apart. Two presses dispatched inside one tick would both see the old
     * state, so the guard that has to hold is the synchronous one — and a
     * doubled press would be two upstream requests for one fare.
     */
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => {
      result.current.collect(LIM_CUZ);
      result.current.collect(LIM_CUZ);
    });

    await waitFor(() => expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]));
    expect(api.calls).toHaveLength(1);
  });

  it('files the outcome under the row that asked for it', async () => {
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    // `mutate` dispatches the request a tick later, so the stub has nothing to
    // release until the call has actually been made.
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await act(async () => {
      api.answer(passOver(LIM_CUZ));
    });

    await waitFor(() => expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(true));
    expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('1 departure looked at');
    expect(result.current.reports.has(routeId(LIM_MAD))).toBe(false);
  });

  it('says so on the row when the call itself fails', async () => {
    // A press that comes back with nothing on screen is a broken button as far
    // as the reader is concerned, whether the failure was the provider's or
    // the API's.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'Too many routes' }, { status: 400 })),
    );
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));

    await waitFor(() => expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(true));
    const report = result.current.reports.get(routeId(LIM_CUZ))!;
    expect(report.ok).toBe(false);
    expect(report.text).toContain('Too many routes');
    expect(result.current.collecting).toEqual([]);
  });

  it('follows a pass the press only started, and reports it when it ends', async () => {
    /*
     * 12.210, and the whole of what it buys. The press used to hold the
     * connection open for the length of the collection, which put the
     * browser's five-minute deadline in charge of how much of a watchlist one
     * press could cover — forty paced requests was as much as fitted, and the
     * owner's two watched months expand to sixty-two departures. A press that
     * returns immediately has no deadline to fit inside, so the row has to
     * keep following rather than keep waiting.
     *
     * It follows by listening now rather than by asking every two seconds —
     * `a-pass-is-pushed-not-polled` — and what the row reports is unchanged,
     * because the frame is the same document the poll used to fetch.
     */
    stubPassInProgress(passRunning(LIM_CUZ));
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
    // Still working, and the row says how far through rather than spinning.
    expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]);
    expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('0 of 31');

    await act(async () => {
      streamed().emit('pass', passRunning(LIM_CUZ, { completed: 4 }));
    });
    expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('4 of 31');
    // The row is still working: a pass in flight must not read as a finished
    // one, which is the failure the whole progress document exists to avoid.
    expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]);

    await act(async () => {
      streamed().emit('pass', passOver(LIM_CUZ));
    });
    expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('1 departure looked at');
    expect(result.current.collecting).toEqual([]);
    // The pass is over, so the connection it was being followed on goes too.
    expect(streamed().closed).toBe(true);
  });

  it('carries the fraction of the pass beside the words, and drops it when it ends', async () => {
    /*
     * The bar and the sentence are two readings of one document and they are
     * deliberately not the same value: the sentence is the last thing the row
     * was told and survives the press, the fraction exists only while the pass
     * runs. What this pins is the second half — that the entry goes when the
     * pass stops, whichever way it stopped. A bar frozen at four of thirty-one
     * beside "Collected: 1 departure looked at" would be the row saying two
     * things at once, and the picture is the louder one.
     */
    stubPassInProgress(passRunning(LIM_CUZ));
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
    expect(result.current.progress.get(routeId(LIM_CUZ))).toEqual({
      completed: 0,
      polling: 31,
      fraction: 0,
    });

    await act(async () => {
      streamed().emit('pass', passRunning(LIM_CUZ, { completed: 4 }));
    });
    expect(result.current.progress.get(routeId(LIM_CUZ))?.completed).toBe(4);

    await act(async () => {
      streamed().emit('pass', passOver(LIM_CUZ));
    });
    expect(result.current.progress.has(routeId(LIM_CUZ))).toBe(false);
    expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('1 departure looked at');
  });

  it('leaves a row with no bar when the press met somebody else’s pass', async () => {
    // `passProgress` refuses a pass this row did not start, and the refusal has
    // to survive the trip through the hook: the row is already saying in words
    // that its own month was not collected, and a bar filling beside that
    // sentence would contradict it in the medium the reader looks at first.
    const elsewhere = { ...passRunning(LIM_CUZ), watching: ['LIM-MAD 2026-12'] };
    stubPassInProgress(elsewhere, [elsewhere]);
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));

    // The row is still watching — the pass it was handed is running, and it
    // will be told when that ends. What it must not do meanwhile is draw the
    // stranger's progress as its own, so the words land and the bar does not.
    await waitFor(() => expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(true));
    expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('already running');
    expect(result.current.progress.has(routeId(LIM_CUZ))).toBe(false);
  });

  it('says so when the press was answered with somebody else’s pass', async () => {
    /*
     * One pass runs at a time — 12.210 — because the collector's gap paces one
     * loop and two loops would halve it with nobody having decided to. A press
     * that meets a running pass is handed that pass, and a row that reported
     * it as its own would be claiming to have collected a month nobody looked
     * at. `watching` is the only thing that tells them apart.
     */
    const elsewhere = { ...passRunning(LIM_CUZ), watching: ['LIM-MAD 2026-12'] };
    stubPassInProgress(elsewhere, [elsewhere]);
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));

    await waitFor(() => expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(true));
    const report = result.current.reports.get(routeId(LIM_CUZ))!;
    expect(report.ok).toBe(false);
    expect(report.text).toContain('LIM-MAD 2026-12');
    expect(report.text).toContain('already running');
  });

  it('reports a pass that fell over as a failure rather than as a quiet nothing', async () => {
    // 8.8. A background task that dies has nowhere to raise, so the state it
    // leaves behind is the only thing that can say what happened — and the
    // server announces both endings on the stream for exactly this reason.
    stubPassInProgress(passRunning(LIM_CUZ));
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
    await act(async () => {
      streamed().emit('pass', {
        ...passOver(LIM_CUZ),
        state: 'failed',
        results: [],
        error: 'RuntimeError: the archive volume went away',
      });
    });

    const report = result.current.reports.get(routeId(LIM_CUZ))!;
    expect(report.ok).toBe(false);
    expect(report.text).toContain('the archive volume went away');
    expect(result.current.collecting).toEqual([]);
  });

  it('gains the chart a point as a departure lands, without asking for anything', async () => {
    /*
     * **The point of the exercise.** A pass is minutes long and the charts read
     * `GET /api/fares/history`, which answers with every snapshot for the city
     * pair — 91 of them at ~327 kB on this archive, plus 1,846 baseline points
     * at ~123 kB, growing without bound. Refetching that every two seconds to
     * keep the charts fresh would trade a frozen page for 21 MB a pass, so the
     * archive was only refreshed when the pass *ended* and the reader spent
     * four minutes looking at a chart that did not move. Reloading the page was
     * the only thing that made it move, and that is the complaint.
     *
     * So the snapshot arrives on the stream and is laid straight into the query
     * the charts are drawn from. What this pins is that it lands and that it
     * costs no request: `fetch` sees the press and nothing else.
     */
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    const key = ['fares', 'history', LIM_CUZ.origin, LIM_CUZ.destination, LIM_CUZ.month];
    client.setQueryData(key, historyOf(LIM_CUZ));

    stubPassInProgress(passRunning(LIM_CUZ));
    const { result } = renderHook(() => useRouteCollection(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    act(() => result.current.collect(LIM_CUZ));
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
    const before = client.getQueryData<FareHistoryResponse>(key)!.snapshots.length;
    const requestsBefore = vi.mocked(fetch).mock.calls.length;

    const landed = snapshotOf(LIM_CUZ, '2026-08-19T14:00:03+00:00', 350);
    await act(async () => {
      streamed().emit('snapshot', landed);
    });

    const after = client.getQueryData<FareHistoryResponse>(key)!;
    expect(after.snapshots).toHaveLength(before + 1);
    expect(after.snapshots.at(-1)?.offers[0].price).toBe(350);
    // Not one request. That is the whole difference from refetching.
    expect(vi.mocked(fetch).mock.calls).toHaveLength(requestsBefore);
    // And the pass is still running, so the row is still working — the point
    // appeared without the press having ended.
    expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]);
  });

  it('falls back to asking when the stream cannot be established', async () => {
    /*
     * The stream is an improvement on a poll that worked, so it must not be
     * able to make a row worse than it was. An `EventSource` reconnects by
     * itself, which covers a blip; what this covers is the other case — a
     * stream that never comes back, on a network where server-sent events do
     * not survive the trip. A row left waiting for a frame that is not coming
     * is a spinner with no end, which is the failure 8.8 and 8.41 name, so the
     * row says so in words and goes back to asking.
     */
    vi.useFakeTimers();
    try {
      stubPassInProgress(passRunning(LIM_CUZ), [passOver(LIM_CUZ)]);
      const { result } = renderHook(() => useRouteCollection(), { wrapper });

      act(() => result.current.collect(LIM_CUZ));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(FakeEventSource.opened).toHaveLength(1);

      await act(async () => {
        streamed().emit('error');
        // Inside the grace the row waits, because this is what a reconnect
        // looks like from here and a reconnect is the ordinary case.
        await vi.advanceTimersByTimeAsync(4_000);
      });
      expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('0 of 31');
      expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      // Past the grace: said in words, and the connection dropped.
      expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('live feed dropped');
      expect(streamed().closed).toBe(true);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_100);
      });
      // And the poll finished the job the stream could not.
      expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('1 departure looked at');
      expect(result.current.collecting).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps listening when a dropped connection comes back inside the grace', async () => {
    // The reason there is a grace at all. `EventSource` reconnects by itself at
    // about three seconds, so tearing the stream down on the first `error`
    // would give up liveness for the rest of a four-minute pass over a blip.
    vi.useFakeTimers();
    try {
      stubPassInProgress(passRunning(LIM_CUZ));
      const { result } = renderHook(() => useRouteCollection(), { wrapper });

      act(() => result.current.collect(LIM_CUZ));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        streamed().emit('error');
        await vi.advanceTimersByTimeAsync(3_000);
        streamed().emit('open');
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(streamed().closed).toBe(false);
      expect(result.current.reports.get(routeId(LIM_CUZ))?.text).not.toContain('live feed');
      expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]);

      await act(async () => {
        streamed().emit('pass', passOver(LIM_CUZ));
      });
      expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('1 departure looked at');
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens one stream for two rows following the same pass', async () => {
    // The server keeps one pass slot, so both rows are following the same pass
    // and a second connection would carry identical frames.
    stubPassInProgress(passRunning(LIM_CUZ, { watching: ['LIM-CUZ 2026-10', 'LIM-MAD 2026-12'] }));
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
    act(() => result.current.collect(LIM_MAD));
    await waitFor(() => expect(result.current.collecting).toHaveLength(2));

    expect(FakeEventSource.opened).toHaveLength(1);
  });

  it('drops a row’s report when the row goes', async () => {
    // Route ids are content, not handles: the same pair in the same month
    // rebuilds the same id, so a stale line would reappear under a route that
    // had just been added back.
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await act(async () => {
      api.answer(passOver(LIM_CUZ));
    });
    await waitFor(() => expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(true));

    act(() => result.current.forget(routeId(LIM_CUZ)));
    expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(false);
  });
});
