import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { routeId, routeLabel, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { describeHorizon, describeRefusal, type RowReport } from '@/features/airfare/lib/rowReport';
import {
  collectCalendar,
  fetchCalendarCollection,
  type CalendarCollectResponse,
} from '@/shared/api/fares';

/**
 * How often a running horizon pass is asked how it is getting on.
 *
 * Two seconds, as the board pass is polled at, and against a pass that is two
 * upstream requests three seconds apart — so the answer arrives within a poll
 * of the curve landing. The call reads state the API already holds in memory
 * and reaches no upstream.
 */
const PROGRESS_POLL_MS = 2_000;

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
  // The poll outlives the render that started it, so it has to be able to find
  // out that the page has gone. Without this, a pass left running while the
  // reader navigates away sets state on an unmounted tree every two seconds.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

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

  const watch = useCallback(
    async (route: FareRoute) => {
      const id = routeId(route);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS));
        if (!mounted.current) return;
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
      void watch(route);
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
