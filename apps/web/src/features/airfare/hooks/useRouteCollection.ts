import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import {
  describeCollection,
  describeProgress,
  describeRefusal,
  type RowReport,
} from '@/features/airfare/lib/rowReport';
import { collectFares, fetchCollectionProgress, type CollectResponse } from '@/shared/api/fares';

/**
 * How often a running pass is asked how it is getting on.
 *
 * Two seconds against a pass whose own requests are three apart, so the row
 * never sits on a figure that is more than one departure stale. The call reads
 * state the API already holds in memory and reaches no upstream, which is what
 * makes polling the cheap half of this arrangement.
 */
const PROGRESS_POLL_MS = 2_000;

/**
 * Collecting one watched route on its own, from the row it sits on.
 *
 * **A press now runs the schedule rather than bypassing it** — 12.111,
 * superseding the second half of 12.90. That decision was right while a press
 * bought one request: someone who has decided where to spend one should not be
 * argued with by a cadence table. Under 12.110 a row is a month and the same
 * press buys up to thirty-one, which is a tenth of the day's budget per click
 * — so `POST /api/fares/collect` calls `collect_due` and the press collects
 * every departure that has news in it and declines the rest. What it declined
 * comes back in `skipped` and the row says so, which is why `describeCollection`
 * has always had that branch.
 *
 * **A press starts a pass and then watches it** — 12.210. The call used to
 * hold the connection open for the whole collection, and the browser's own
 * five-minute deadline was therefore what decided how much of a watchlist one
 * press could cover: the server capped a pass at forty requests because forty
 * paced requests was what fitted. The owner's two watched months expand to
 * sixty-two departures, so a full refresh took two presses with a person in
 * between. Now the press returns as soon as the pass has started and this
 * polls `GET /api/fares/collect` until it stops running, so the row reports a
 * pass it is watching rather than one it is blocking on, and nothing bounds a
 * pass except the request budget.
 *
 * The invalidation moved with it. Refreshing the archive's queries at the
 * moment the press returns would now refetch exactly what is already on
 * screen, so it happens when the pass ends.
 *
 * **One mutation, many rows.** A hook cannot be called in a loop, so per-row
 * state lives here as two collections keyed by `routeId`: which presses are in
 * flight, and what the last one on each row came back with. React Query's own
 * `isPending` is deliberately not used for the disabling — it is one flag for
 * the whole mutation, and reading it per row is exactly how one row's press
 * ends up greying out every other row's button.
 *
 * The in-flight guard is a ref as well as state because only the ref is
 * synchronous. `disabled` on the button stops the second press of a human
 * double-click, which is tens of milliseconds and several renders later; two
 * presses dispatched inside one tick would both see the old state and both
 * fire, and the ref is what closes that.
 */
export type RouteCollection = {
  /** Route ids whose own press is in flight. */
  collecting: readonly string[];
  /** What the last press on a row came back with, by route id. */
  reports: ReadonlyMap<string, RowReport>;
  collect: (route: FareRoute) => void;
  /** Drop a row's report, for when the row itself goes. */
  forget: (id: string) => void;
};

export function useRouteCollection(): RouteCollection {
  const queryClient = useQueryClient();
  const [collecting, setCollecting] = useState<readonly string[]>([]);
  const [reports, setReports] = useState<ReadonlyMap<string, RowReport>>(() => new Map());
  const inFlight = useRef<Set<string>>(new Set());
  // The poll outlives the render that started it, so it has to be able to find
  // out that the page has gone. Without this, a pass left running while the
  // reader navigates away sets state on an unmounted tree every two seconds
  // until it finishes.
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
   * Watch a pass the press has already started, until it stops running.
   *
   * The refresh happens here rather than in `onSuccess` for the reason the
   * whole change exists — 12.210: the press now returns before a single
   * departure has been collected, so invalidating the archive's queries at
   * that moment would refetch exactly what was already on screen.
   */
  const watch = useCallback(
    async (route: FareRoute) => {
      const id = routeId(route);
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, PROGRESS_POLL_MS));
        if (!mounted.current) return;
        let progress: CollectResponse;
        try {
          progress = await fetchCollectionProgress();
        } catch (error) {
          write(id, describeRefusal(error instanceof Error ? error.message : String(error)));
          release(id);
          return;
        }
        if (!mounted.current) return;
        if (progress.state === 'running') {
          write(id, describeProgress(route, progress));
          continue;
        }
        write(id, describeCollection(route, progress));
        release(id);
        void queryClient.invalidateQueries({ queryKey: ['fares', 'history'] });
        void queryClient.invalidateQueries({ queryKey: ['fares', 'airports'] });
        return;
      }
    },
    [queryClient, release, write],
  );

  // Only `mutate` is taken off the result: the object React Query returns is
  // new on every render, so closing over it would rebuild `collect` every
  // render and defeat the `useCallback` around it. `mutate` itself is stable.
  const { mutate } = useMutation<CollectResponse, Error, FareRoute>({
    mutationFn: (route) =>
      collectFares([
        {
          origin: route.origin,
          destination: route.destination,
          month: route.month,
          // A press buys up to thirty-one departures, and a pass can still
          // truncate — not at forty any more (12.210 removed that), but at
          // the request budget. The focused day is what the pass keeps first
          // when it does (12.134).
          ...(route.focusDate ? { focusDate: route.focusDate } : {}),
          currency: route.currency,
        },
      ]),
    // The press only starts the pass — 12.210 — so this is where the watching
    // begins rather than where the outcome is written. A pass that came back
    // already finished (nothing was due, or somebody else's pass was handed
    // over) is done here and never polls.
    onSuccess: (data, route) => {
      const id = routeId(route);
      if (data.state !== 'running') {
        write(id, describeCollection(route, data));
        release(id);
        void queryClient.invalidateQueries({ queryKey: ['fares', 'history'] });
        void queryClient.invalidateQueries({ queryKey: ['fares', 'airports'] });
        return;
      }
      write(id, describeProgress(route, data));
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
      if (inFlight.current.has(id)) return;
      inFlight.current.add(id);
      setCollecting((current) => [...current, id]);
      // The previous outcome goes with the press that supersedes it. Leaving
      // last week's "Refused" beside a spinner would have the row saying two
      // things at once, and the older one louder.
      write(id, null);
      mutate(route);
    },
    [mutate, write],
  );

  const forget = useCallback((id: string) => write(id, null), [write]);

  return { collecting, reports, collect, forget };
}
