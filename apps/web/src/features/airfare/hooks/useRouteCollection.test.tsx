import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { useRouteCollection } from '@/features/airfare/hooks/useRouteCollection';
import { NOTICE_LIFE_MS } from '@/features/airfare/lib/collectNotice';
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
  months: ['2026-10'],
  currency: 'USD',
};

const LIM_MAD: FareRoute = {
  origin: 'LIM',
  destination: 'MAD',
  months: ['2026-12'],
  currency: 'USD',
};

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/**
 * The same client with its garbage collection switched off.
 *
 * React Query schedules a `setTimeout` per cache entry to sweep it, and an
 * infinite `gcTime` is the documented way to say "never" — `isValidTimeout`
 * rejects `Infinity` and no timer is created. Only the test that counts this
 * hook's own timers needs it, and it needs it to be counting nothing else.
 */
function steadyWrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { retry: false, gcTime: Infinity },
    },
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
    watching: route.months.map((month) => `${route.origin}-${route.destination} ${month}`),
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
        flightDate: `${route.months[0]}-09`,
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
    flightDate: `${route.months[0]}-09`,
    returnDate: null,
    currency: 'USD',
    insights: null,
    offers: [
      {
        airline: 'LA',
        airlineName: 'LATAM',
        flightNumber: 'LA600',
        departureAt: `${route.months[0]}-09T08:00`,
        arrivalAt: `${route.months[0]}-09T10:00`,
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
    baseline: [{ flightDate: `${route.months[0]}-09`, date: '2026-08-01', price: 410 }],
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
    // The bulk button sent the whole watchlist; a row press sends one city
    // pair, or pressing it would spend the day on eight other routes.
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_MAD, LIM_MAD.months[0]));

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
      force: true,
    });
  });

  it('asks for the month now rather than for whatever the cadence thinks is due', async () => {
    /*
     * `a-press-collects-the-month-it-is-on`, settling 12.212. The complaint it
     * reproduced was a press at 21:04 after a pass at 14:41 answering
     * `31 not-due`, which is 12.111 working as designed and is the wrong answer
     * to give somebody who has just said they do not believe the last look.
     *
     * Asserted on the wire word rather than on an outcome, because that is the
     * whole of what this side decides: the server refuses `force` with anything
     * but one route, and the row is the only control that sends it.
     */
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));

    await waitFor(() => expect(api.calls).toHaveLength(1));
    const body = api.calls[0] as { routes: unknown[]; force: boolean };
    expect(body.force).toBe(true);
    // One *city pair*, which is the bound the whole decision now rests on. It
    // was one route entry, and the two were the same thing only while a watch
    // was one month — see the endpoint, which draws the line at the pair.
    expect(body.routes).toHaveLength(1);
  });

  it('sends only the month it was handed, whatever else the watch holds', async () => {
    /*
     * The reversal — `a-press-collects-the-month-on-screen`.
     *
     * It sent every month of the watch in one pass, and the row is showing one
     * month at a time: collecting the other two was the button doing more than
     * the reader could see it do, and on a twelve-month watch that is ~372
     * requests and nineteen minutes behind a control that answers instantly.
     */
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() =>
      result.current.collect({ ...LIM_MAD, months: ['2026-10', '2026-12', '2027-02'] }, '2026-12'),
    );

    await waitFor(() => expect(api.calls).toHaveLength(1));
    const body = api.calls[0] as { routes: { month: string }[]; force: boolean };
    expect(body.routes.map((route) => route.month)).toEqual(['2026-12']);
    expect(body.force).toBe(true);
  });

  it('sends a month that has gone rather than swallowing the press', async () => {
    /*
     * The other half of the reversal, and the reasoning goes with it.
     *
     * Departed months were filtered out because a wholly departed month bought
     * thirty-one skip lines that pushed the reasons that mattered out of the
     * row's commonest-first summary. With one month there are no other reasons
     * to crowd out, so `Not collected: 31 departed.` is the whole sentence —
     * true, useful, and built from machinery that already exists.
     *
     * A press that quietly sent nothing would be the silent no-op the row's own
     * report line exists to prevent (8.8, 8.41).
     */
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect({ ...LIM_MAD, months: ['2020-01', '2026-12'] }, '2020-01'));

    await waitFor(() => expect(api.calls).toHaveLength(1));
    const body = api.calls[0] as { routes: { month: string }[] };
    expect(body.routes.map((route) => route.month)).toEqual(['2020-01']);
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

    act(() => result.current.collect(LIM_MAD, LIM_MAD.months[0]));
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

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
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
      result.current.collect(LIM_CUZ, LIM_CUZ.months[0]);
      result.current.collect(LIM_CUZ, LIM_CUZ.months[0]);
    });

    await waitFor(() => expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]));
    expect(api.calls).toHaveLength(1);
  });

  it('spends one month for five impatient presses, all the way to the end of the pass', async () => {
    /*
     * The hazard 12.212 named, and the reason it is worth its own test now that
     * a press ignores the cadence.
     *
     * A forced press is roughly ninety seconds of paced requests behind a
     * control that answers instantly, so a reader clicking again because
     * nothing has visibly happened is the ordinary case. The guard has to hold
     * for the whole pass and not just for the call: `release` runs when the
     * pass **ends**, so `inFlight` is still set while the stream is delivering
     * departures — which is exactly the window somebody clicks in.
     *
     * Five presses, spread across the press being answered and two progress
     * frames arriving, and one call goes out. The sixth press after the pass
     * has finished does start a second pass, and that is right: the reader has
     * seen the outcome and asked again.
     *
     * This is the browser's guard. It is not what makes the change safe —
     * a second tab defeats it — and the server's single pass slot is tested
     * where it lives, in `test_five_impatient_presses_start_one_pass`.
     */
    stubPassInProgress(passRunning(LIM_CUZ));
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));

    await act(async () => {
      result.current.collect(LIM_CUZ, LIM_CUZ.months[0]);
      streamed().emit('pass', passRunning(LIM_CUZ, { completed: 4 }));
    });
    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
    await act(async () => {
      streamed().emit('pass', passRunning(LIM_CUZ, { completed: 9 }));
      result.current.collect(LIM_CUZ, LIM_CUZ.months[0]);
    });
    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));

    // One POST across all five, and the row never stopped saying it was busy.
    const posts = (
      globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
    ).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(result.current.collecting).toEqual([routeId(LIM_CUZ)]);
    // And one stream, not five.
    expect(FakeEventSource.opened).toHaveLength(1);

    await act(async () => {
      streamed().emit('pass', passOver(LIM_CUZ));
    });
    await waitFor(() => expect(result.current.collecting).toEqual([]));
  });

  it('files the outcome under the row that asked for it', async () => {
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
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

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));

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

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
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

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
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

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));

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

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));

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

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
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
    const key = ['fares', 'history', LIM_CUZ.origin, LIM_CUZ.destination, LIM_CUZ.months[0]];
    client.setQueryData(key, historyOf(LIM_CUZ));

    stubPassInProgress(passRunning(LIM_CUZ));
    const { result } = renderHook(() => useRouteCollection(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
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

  it('marks the day’s spend for a re-read when the pass it started ends', async () => {
    /*
     * `spend-is-read-back-not-only-written`. The header strip refetches on its own every
     * minute, so this is not what keeps it current — it is what keeps it from
     * lagging the one piece of spending the reader can attribute to themselves.
     * A press that visibly polls thirty-one departures and leaves the figure
     * beside the title unchanged for the best part of a minute teaches the
     * reader that the strip is slow, which is the belief it can least afford.
     */
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });
    client.setQueryData(['fares', 'spend'], { spent: 12 });

    stubPassInProgress(passRunning(LIM_CUZ));
    const { result } = renderHook(() => useRouteCollection(), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
    expect(client.getQueryState(['fares', 'spend'])?.isInvalidated).toBe(false);

    await act(async () => {
      streamed().emit('pass', passOver(LIM_CUZ));
    });

    expect(client.getQueryState(['fares', 'spend'])?.isInvalidated).toBe(true);
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

      act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
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

      act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
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

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));
    act(() => result.current.collect(LIM_MAD, LIM_MAD.months[0]));
    await waitFor(() => expect(result.current.collecting).toHaveLength(2));

    expect(FakeEventSource.opened).toHaveLength(1);
  });

  it('drops a row’s report when the row goes', async () => {
    // Route ids are content, not handles: the same pair in the same month
    // rebuilds the same id, so a stale line would reappear under a route that
    // had just been added back.
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await act(async () => {
      api.answer(passOver(LIM_CUZ));
    });
    await waitFor(() => expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(true));

    act(() => result.current.forget(routeId(LIM_CUZ)));
    expect(result.current.reports.has(routeId(LIM_CUZ))).toBe(false);
  });
});

/**
 * A press the reader made, announced where they are actually looking.
 *
 * The line under the row is unchanged and still the durable copy — it stays
 * until the next press supersedes it. What this adds is a card that appears on
 * its own and goes on its own, because a pass is minutes long and the reader
 * has by then scrolled the watchlist, opened a chart, or moved to another
 * window. A sentence that only exists two hundred pixels below where they are
 * looking is a sentence they will not read.
 */
describe('the card a finished press leaves in the corner', () => {
  it('raises the row’s own sentence and takes it away by itself', async () => {
    vi.useFakeTimers();
    try {
      const api = stubCollect();
      const { result } = renderHook(() => useRouteCollection(), { wrapper });

      act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      // Nothing while it is still running: a card raised on the first frame
      // would have faded before the pass it announced had finished.
      expect(result.current.notices).toEqual([]);

      await act(async () => {
        api.answer(passOver(LIM_CUZ));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.notices).toHaveLength(1);
      expect(result.current.notices[0].report.text).toContain('1 departure looked at');
      // Word for word what the row is saying, because both come from
      // `describeCollection` rather than from two sentences about one pass.
      expect(result.current.notices[0].report.text).toBe(
        result.current.reports.get(routeId(LIM_CUZ))?.text,
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(NOTICE_LIFE_MS - 500);
      });
      expect(result.current.notices).toHaveLength(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(result.current.notices).toEqual([]);
      // And the row keeps it. The card is the announcement; the line is the
      // record, and a reader coming back to the row still finds out what
      // happened.
      expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('1 departure looked at');
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing about a pass the reader did not start', async () => {
    /*
     * The scheduled collector runs every fifteen minutes with nobody watching,
     * and a press made while it is running is answered with *that* pass rather
     * than served with its own — 12.210. Neither is an outcome the reader
     * asked to be interrupted with, and `isOurPass` is the one question that
     * tells them apart. The row still says what happened, in words, where
     * somebody who cares can go and read it.
     */
    const foreign = { ...passOver(LIM_CUZ), watching: ['ARI-SCL 2027-03'] };
    stubPassInProgress(passRunning(LIM_CUZ, { watching: ['ARI-SCL 2027-03'] }));
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
    await waitFor(() => expect(FakeEventSource.opened).toHaveLength(1));

    await act(async () => {
      streamed().emit('pass', foreign);
    });

    expect(result.current.reports.get(routeId(LIM_CUZ))?.text).toContain('already running');
    expect(result.current.notices).toEqual([]);
  });

  it('gives each row its own card and lets a second press replace it', async () => {
    // Two rows can be following one pass — the server keeps a single slot —
    // so one row's outcome must not swallow the other's. A row's *own* second
    // press is the opposite case: it has one latest outcome by definition, and
    // two cards for it would be the older one arguing with the newer.
    vi.useFakeTimers();
    try {
      const both = {
        ...passOver(LIM_CUZ),
        watching: ['LIM-CUZ 2026-10', 'LIM-MAD 2026-12'],
        results: [...passOver(LIM_CUZ).results, ...passOver(LIM_MAD).results],
      };
      stubPassInProgress(
        passRunning(LIM_CUZ, { watching: ['LIM-CUZ 2026-10', 'LIM-MAD 2026-12'] }),
      );
      const { result } = renderHook(() => useRouteCollection(), { wrapper });

      act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
      act(() => result.current.collect(LIM_MAD, LIM_MAD.months[0]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      await act(async () => {
        streamed().emit('pass', both);
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.notices.map((card) => card.id)).toEqual([
        routeId(LIM_CUZ),
        routeId(LIM_MAD),
      ]);

      // Late enough that the first pair are nearly out of time, so a card that
      // did not restart its clock would be gone a moment after the new press.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(NOTICE_LIFE_MS - 1_000);
      });
      act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
      // The press has to have been answered before there is a stream to speak
      // through: the first pass ended, which closed the last one.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        streamed().emit('pass', {
          ...both,
          results: [...passOver(LIM_CUZ, { changed: false }).results],
        });
        await vi.advanceTimersByTimeAsync(2_000);
      });

      // LIM-MAD's ran out on its own clock; LIM-CUZ's is the second press's,
      // in its own right rather than the first one's stretched.
      expect(result.current.notices.map((card) => card.id)).toEqual([routeId(LIM_CUZ)]);
      expect(result.current.notices[0].report.text).toContain('nothing new to record');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops a row’s card when the row goes', async () => {
    // The same argument as the report: route ids are content rather than
    // handles, so a card left behind would reappear over a route that had just
    // been added back.
    const api = stubCollect();
    const { result } = renderHook(() => useRouteCollection(), { wrapper });

    act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
    await waitFor(() => expect(api.calls).toHaveLength(1));
    await act(async () => {
      api.answer(passOver(LIM_CUZ));
    });
    await waitFor(() => expect(result.current.notices).toHaveLength(1));

    act(() => result.current.forget(routeId(LIM_CUZ)));
    expect(result.current.notices).toEqual([]);
  });

  it('takes its timers with it when the page goes', async () => {
    /*
     * A pass outlives the render that started it, and the reader can navigate
     * away mid-card. The timer is cancellable and cancelled on unmount for the
     * reason the stream is closed on unmount: a callback firing into a tree
     * that is gone is at best wasted and at worst a leak that accumulates one
     * per press for as long as the tab is open.
     *
     * The client is given an infinite `gcTime` so that React Query schedules
     * no timers of its own and the count below is this hook's alone.
     */
    vi.useFakeTimers();
    try {
      const api = stubCollect();
      const { result, unmount } = renderHook(() => useRouteCollection(), {
        wrapper: steadyWrapper,
      });

      act(() => result.current.collect(LIM_CUZ, LIM_CUZ.months[0]));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      await act(async () => {
        api.answer(passOver(LIM_CUZ));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(result.current.notices).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(1);

      unmount();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
