import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { openHorizonStream } from '@/features/airfare/data/collectionStream';
import { routeId, routeLabel, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { horizonProgress, type HorizonProgress } from '@/features/airfare/lib/horizonProgress';
import {
  describeHorizon,
  describeHorizonProgress,
  describeRefusal,
  type RowReport,
} from '@/features/airfare/lib/rowReport';
import {
  collectCalendar,
  fetchCalendarCollection,
  type CalendarCollectResponse,
} from '@/shared/api/fares';

/**
 * How often a running horizon pass is asked how it is getting on, **when the
 * stream is not available**.
 *
 * Two seconds, as the board pass falls back to, and against a pass that is two
 * upstream requests three seconds apart — so the answer arrives within a poll
 * of the curve landing. The call reads state the API already holds in memory
 * and reaches no upstream.
 */
const PROGRESS_POLL_MS = 2_000;

/**
 * How long a broken stream is given to come back before the row stops waiting.
 *
 * The board collection's window, for the board collection's reason: an
 * `EventSource` reconnects by itself at about three seconds, this covers two
 * attempts, and what it protects against is a stream that cannot be
 * established at all. A row waiting on a frame that is never coming is a
 * spinner with no end — 8.8.
 */
const STREAM_GRACE_MS = 8_000;

/**
 * Collecting a route's whole booking horizon, fired by adding the route —
 * 12.247.
 *
 * **Why this is the one collection that happens by itself.** Everything else on
 * this page is collected on a press or on the schedule, and deliberately: the
 * upstream is unmetered and the repository paces itself against it by hand. A
 * horizon is the exception because of what it costs and what it buys. It is a
 * handful of requests once per city pair, rather than one per departure — and
 * without it the departure chart has nothing at all to draw outside the watched
 * month, which since the zoom went is most of what that chart is for. A route
 * added and then found to be blank everywhere except its own month is a route
 * that looks broken.
 *
 * **The route is added whatever happens here.** The add is a write to the
 * reader's own stored document; this is a request to somebody else's server,
 * and the two fail for unrelated reasons. Rolling the add back on a refusal
 * would let an upstream veto a watchlist edit — the wrong trade, and one the
 * reader could not even retry, since the row they would retry from would not
 * exist. So the collection runs behind the add, it is reported in words, and
 * until it lands the chart says the horizon is not collected yet.
 *
 * **One at a time, because the server keeps one slot.** A press that arrives
 * while a pass is running is answered with that pass rather than starting a
 * second one, and `watching` is how this hook tells which happened.
 *
 * **It listens rather than asks** — `a-pass-is-pushed-not-polled`. This used to
 * sleep two seconds in a loop and re-ask `GET /api/fares/calendar/collect`; it
 * now opens `GET /api/fares/calendar/collect/stream` and is told. There is no
 * `snapshot` event on that stream and nothing is missing by it: a pair writes
 * one curve and writes it at the very end, so the chart refreshes from
 * `GET /calendar` when the pass stops — a few hundred points once a day per
 * pair, nothing like the unbounded `/history` payload that made pushing the
 * board's snapshots worth the trouble.
 *
 * **What was missing was the middle** — `a-horizon-pass-shows-its-work`. This
 * hook used to treat every `running` frame as nothing to say, on the belief
 * that a pass of two requests has no halfway point. A pass measured live on
 * 2026-08-21 was three requests and twenty seconds, because a far window was
 * refused and walked back (12.245), and for the whole of it one unchanging
 * sentence sat under the watchlist. The frames now carry windows priced,
 * requests spent and dates so far, and both the bar and the words move with
 * them.
 *
 * The poll stays as the fallback, for the board collection's reason: on a
 * network where server-sent events do not survive the trip, this must not be
 * able to make the row worse than it was.
 */
export type HorizonCollection = {
  /** Route ids whose horizon pass is in flight. */
  collecting: readonly string[];
  /** What the last pass for a row came back with, by route id. */
  reports: ReadonlyMap<string, RowReport>;
  /** How far each running horizon pass has got, by route id. Absent means no bar. */
  progress: ReadonlyMap<string, HorizonProgress>;
  collect: (route: FareRoute) => void;
  /** Drop a row's report, for when the row itself goes. */
  forget: (id: string) => void;
};

export function useHorizonCollection(): HorizonCollection {
  const queryClient = useQueryClient();
  const [collecting, setCollecting] = useState<readonly string[]>([]);
  const [reports, setReports] = useState<ReadonlyMap<string, RowReport>>(() => new Map());
  /**
   * The bar, kept beside the words rather than derived from them.
   *
   * Separate state for the same reason `useRouteCollection` keeps its own: the
   * sentence outlives the pass and the fraction does not, so a finished pass
   * clears this map and leaves `reports` standing.
   */
  const [progress, setProgress] = useState<ReadonlyMap<string, HorizonProgress>>(() => new Map());
  const inFlight = useRef<Set<string>>(new Set());
  /**
   * The rows following the pass, by route id.
   *
   * A ref rather than state: it is read by stream callbacks that outlive the
   * render which registered them. One stream serves all of them, because the
   * server keeps one calendar slot and a second `EventSource` would carry the
   * same frames twice.
   */
  const following = useRef<Map<string, FareRoute>>(new Map());
  const closeStream = useRef<(() => void) | null>(null);
  const graceTimer = useRef<number | null>(null);
  // The stream and the poll both outlive the render that started them, so both
  // have to be able to find out that the page has gone. Without this, a pass
  // left running while the reader navigates away sets state on an unmounted
  // tree until it finishes.
  const mounted = useRef(true);

  const write = useCallback((id: string, report: RowReport | null) => {
    setReports((current) => {
      const next = new Map(current);
      if (report) next.set(id, report);
      else next.delete(id);
      return next;
    });
  }, []);

  const draw = useCallback((id: string, bar: HorizonProgress | null) => {
    setProgress((current) => {
      // A pass with nothing to draw and a map that already has nothing for this
      // row is the commonest call here — every frame of a finished pass. Left
      // unchecked it would replace the map on each one and re-render the panel
      // for no change at all.
      if (bar === null && !current.has(id)) return current;
      const next = new Map(current);
      if (bar) next.set(id, bar);
      else next.delete(id);
      return next;
    });
  }, []);

  const release = useCallback(
    (id: string) => {
      inFlight.current.delete(id);
      setCollecting((current) => current.filter((other) => other !== id));
      // The bar goes when the pass does. A track left at whatever fraction it
      // reached would go on claiming work beside a line saying the work is done.
      draw(id, null);
    },
    [draw],
  );

  /**
   * The curve is a fact about a city pair rather than about a watch, so every
   * watch on that pair reads the same row. Invalidating by pair alone is what
   * makes a second watch on the same route see the horizon the first one
   * collected.
   */
  const refresh = useCallback(
    (route: FareRoute) => {
      void queryClient.invalidateQueries({
        queryKey: ['fares', 'calendar', route.origin, route.destination],
      });
    },
    [queryClient],
  );

  const stopStream = useCallback(() => {
    closeStream.current?.();
    closeStream.current = null;
    if (graceTimer.current !== null) {
      window.clearTimeout(graceTimer.current);
      graceTimer.current = null;
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      stopStream();
    };
  }, [stopStream]);

  /**
   * One pass document, read by every row that is following it.
   *
   * Each row asks `describeHorizon` of the same document, and that function
   * checks `watching` for itself — a press that met a running pass was answered
   * with that pass rather than served with its own, and a row reporting a
   * stranger's curve as its own would be claiming a chart it has not got.
   */
  const applyPass = useCallback(
    (response: CalendarCollectResponse) => {
      if (!mounted.current) return;
      /*
       * A running pass now has something to say, and this is where it used to
       * be thrown away.
       *
       * The line here was `if (response.state === 'running') return;` — the
       * client half of the belief that a horizon pass has no halfway point. It
       * meant the row wrote one sentence when the press landed and then
       * literally nothing until the pass stopped, so the same words sat
       * unchanged for the twenty seconds a refused window costs. A control that
       * says the same thing for twenty seconds is indistinguishable from one
       * that has hung.
       *
       * The server sends a frame as each request goes out and as each window
       * comes back, so every one of these is news. Both halves are written: the
       * bar, and the sentence under it.
       */
      if (response.state === 'running') {
        for (const [id, route] of following.current) {
          draw(id, horizonProgress(route, response));
          write(id, describeHorizonProgress(route, response));
        }
        return;
      }
      for (const [id, route] of [...following.current]) {
        following.current.delete(id);
        write(id, describeHorizon(route, response));
        release(id);
        refresh(route);
      }
      if (following.current.size === 0) stopStream();
    },
    [draw, refresh, release, stopStream, write],
  );

  /**
   * Ask instead of listen, for as long as this row's pass runs.
   *
   * The fallback, unchanged in what it reports. A row that arrives here loses
   * nothing but the promptness of the answer — the same document, the same
   * sentence, up to two seconds later.
   */
  const pollUntilDone = useCallback(
    async (route: FareRoute) => {
      const id = routeId(route);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS));
        if (!mounted.current || !inFlight.current.has(id)) return;
        // Named for the pass rather than for progress: `progress` is now the
        // hook's own state a few lines up, and a local shadowing it would be a
        // bug waiting for somebody to move a line.
        let running: CalendarCollectResponse;
        try {
          running = await fetchCalendarCollection();
        } catch (error) {
          write(id, describeRefusal(error instanceof Error ? error.message : String(error)));
          release(id);
          return;
        }
        if (!mounted.current) return;
        if (running.state === 'running') {
          // The same two writes the stream makes, two seconds later. A row that
          // fell back loses the promptness of the answer and nothing else,
          // which is the whole contract of `the-poll-is-the-fallback`.
          draw(id, horizonProgress(route, running));
          write(id, describeHorizonProgress(route, running));
          continue;
        }
        write(id, describeHorizon(route, running));
        release(id);
        refresh(route);
        return;
      }
    },
    [draw, refresh, release, write],
  );

  /**
   * The stream has gone quiet for longer than a reconnect takes.
   *
   * Said in words and then acted on, rather than waited out. A row still
   * spinning on a curve that finished four minutes ago is the failure 8.8
   * names, and this route ends every branch with the route still watched —
   * adding it was a write to the reader's own document and no upstream gets a
   * veto over that.
   */
  const fallBackToPolling = useCallback(() => {
    const stranded = [...following.current.values()];
    following.current.clear();
    stopStream();
    for (const route of stranded) {
      write(routeId(route), {
        ok: false,
        text: `The live feed dropped while collecting the booking horizon for ${routeLabel(route)}; checking every two seconds instead. The route is watched either way.`,
      });
      void pollUntilDone(route);
    }
  }, [pollUntilDone, stopStream, write]);

  const armGrace = useCallback(() => {
    if (graceTimer.current !== null) return;
    graceTimer.current = window.setTimeout(() => {
      graceTimer.current = null;
      if (following.current.size > 0) fallBackToPolling();
    }, STREAM_GRACE_MS);
  }, [fallBackToPolling]);

  const disarmGrace = useCallback(() => {
    if (graceTimer.current === null) return;
    window.clearTimeout(graceTimer.current);
    graceTimer.current = null;
  }, []);

  const follow = useCallback(
    (route: FareRoute) => {
      following.current.set(routeId(route), route);
      if (closeStream.current) return;
      closeStream.current = openHorizonStream({
        onOpen: disarmGrace,
        onPass: (response) => {
          disarmGrace();
          applyPass(response);
        },
        onError: armGrace,
      });
    },
    [applyPass, armGrace, disarmGrace],
  );

  // Only `mutate` is taken off the result: the object React Query returns is
  // new on every render, so closing over it would rebuild `collect` every
  // render and defeat the `useCallback` around it.
  const { mutate } = useMutation<CalendarCollectResponse, Error, FareRoute>({
    mutationFn: (route) =>
      collectCalendar({
        origin: route.origin,
        destination: route.destination,
        currency: route.currency,
      }),
    onSuccess: (data, route) => {
      const id = routeId(route);
      // A pass that came back already finished — nothing was due, or somebody
      // else's pass was handed over — is done here and never polls.
      if (data.state !== 'running') {
        write(id, describeHorizon(route, data));
        release(id);
        refresh(route);
        return;
      }
      /*
       * No duration, on purpose.
       *
       * This said "two requests, about four seconds". Measured live on
       * 2026-08-21 it was three requests and twenty seconds, because the
       * provider refused a far window and the collector walked it back — 12.245
       * working exactly as designed, not a fault. Five times the promised wait
       * is worse than no promise: a reader who was told four seconds and waits
       * twenty concludes the thing is broken, and next time believes nothing
       * the control says.
       *
       * A larger number was the obvious alternative and there is not one to
       * defend. The pass costs however many requests the provider makes it
       * cost, and each is paced three seconds apart, so the honest range runs
       * from about six seconds to about half a minute. What replaces the
       * estimate is not a wider one, it is the thing itself: `describeHorizonProgress`
       * below reports what the pass has actually done, as it does it.
       */
      write(id, {
        ok: true,
        text: `Collecting the booking horizon for ${routeLabel(route)}…`,
      });
      follow(route);
    },
    onError: (error, route) => {
      const id = routeId(route);
      write(id, describeRefusal(error.message));
      release(id);
    },
  });

  const collect = useCallback(
    (route: FareRoute) => {
      const id = routeId(route);
      // The ref is the synchronous half of the guard. Two adds dispatched in
      // one tick would both see the old state and both fire.
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setCollecting((current) => [...current, id]);
      write(id, null);
      mutate(route);
    },
    [mutate, write],
  );

  const forget = useCallback(
    (id: string) => {
      write(id, null);
      draw(id, null);
    },
    [draw, write],
  );

  return { collecting, reports, progress, collect, forget };
}
