import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { openHorizonStream } from '@/features/airfare/data/collectionStream';
import { routeId, routeLabel, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { describeHorizon, describeRefusal, type RowReport } from '@/features/airfare/lib/rowReport';
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
 * horizon is the exception because of what it costs and what it buys. It is two
 * requests and about four seconds, once per city pair rather than once per
 * departure — and without it the departure chart has nothing at all to draw
 * outside the watched month, which since the zoom went is most of what that
 * chart is for. A route added and then found to be blank everywhere except its
 * own month is a route that looks broken.
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
 * `snapshot` event on that stream and there is nothing missing: a curve is one
 * city pair and two paced requests, so there is no halfway point a reader could
 * act on, and "has it stopped yet" is the whole of what the poll was asking.
 * The chart still refreshes from `GET /calendar` when the pass ends, as it did
 * — a curve is a few hundred points collected once a day per pair, nothing like
 * the unbounded `/history` payload that made pushing the board's snapshots
 * worth the trouble.
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
  collect: (route: FareRoute) => void;
  /** Drop a row's report, for when the row itself goes. */
  forget: (id: string) => void;
};

export function useHorizonCollection(): HorizonCollection {
  const queryClient = useQueryClient();
  const [collecting, setCollecting] = useState<readonly string[]>([]);
  const [reports, setReports] = useState<ReadonlyMap<string, RowReport>>(() => new Map());
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

  const release = useCallback((id: string) => {
    inFlight.current.delete(id);
    setCollecting((current) => current.filter((other) => other !== id));
  }, []);

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
      // Nothing to say about a pass still running: a curve has no halfway
      // point, which is why this stream carries only the two states it has.
      if (response.state === 'running') return;
      for (const [id, route] of [...following.current]) {
        following.current.delete(id);
        write(id, describeHorizon(route, response));
        release(id);
        refresh(route);
      }
      if (following.current.size === 0) stopStream();
    },
    [refresh, release, stopStream, write],
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
        let progress: CalendarCollectResponse;
        try {
          progress = await fetchCalendarCollection();
        } catch (error) {
          write(id, describeRefusal(error instanceof Error ? error.message : String(error)));
          release(id);
          return;
        }
        if (!mounted.current) return;
        if (progress.state === 'running') continue;
        write(id, describeHorizon(route, progress));
        release(id);
        refresh(route);
        return;
      }
    },
    [refresh, release, write],
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
      write(id, {
        ok: true,
        text: `Collecting the booking horizon for ${routeLabel(route)} — two requests, about four seconds.`,
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

  const forget = useCallback((id: string) => write(id, null), [write]);

  return { collecting, reports, collect, forget };
}
