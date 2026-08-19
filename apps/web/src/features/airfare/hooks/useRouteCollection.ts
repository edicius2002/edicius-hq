import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef, useState } from 'react';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import {
  describeCollection,
  describeRefusal,
  type RowReport,
} from '@/features/airfare/lib/rowReport';
import { collectFares, type CollectResponse } from '@/shared/api/fares';

/**
 * Collecting one watched route on its own, from the row it sits on.
 *
 * **An explicit press is not the scheduler, and does not have to wait for it.**
 * The cadence in `fare_schedule.due_now` (12.10, 12.17) exists to spend a daily
 * request budget where the prices actually move; a person pressing a button on
 * one row has already decided where to spend one. It needs no new endpoint to
 * say so: `POST /api/fares/collect` calls the collector's unconditional
 * `collect`, never `collect_due`, so the routes it is handed are polled and
 * nothing is measured against a clock. A second endpoint would have been a
 * duplicate of one that already behaves the way this control needs.
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

  const write = useCallback((id: string, report: RowReport | null) => {
    setReports((current) => {
      const next = new Map(current);
      if (report) next.set(id, report);
      else next.delete(id);
      return next;
    });
  }, []);

  // Only `mutate` is taken off the result: the object React Query returns is
  // new on every render, so closing over it would rebuild `collect` every
  // render and defeat the `useCallback` around it. `mutate` itself is stable.
  const { mutate } = useMutation<CollectResponse, Error, FareRoute>({
    mutationFn: (route) =>
      collectFares([
        {
          origin: route.origin,
          destination: route.destination,
          flightDate: route.flightDate,
          returnDate: route.returnDate,
          currency: route.currency,
        },
      ]),
    // The archive grew for this route, and the airport table may have learned
    // where a brand-new destination is. Both queries are invalidated wholesale
    // rather than by route, the same as the whole-list pass does: the reader
    // can switch rows in the time this takes to come back.
    onSuccess: (data, route) => {
      write(routeId(route), describeCollection(route, data));
      void queryClient.invalidateQueries({ queryKey: ['fares', 'history'] });
      void queryClient.invalidateQueries({ queryKey: ['fares', 'airports'] });
    },
    onError: (error, route) => write(routeId(route), describeRefusal(error.message)),
    onSettled: (_data, _error, route) => {
      const id = routeId(route);
      inFlight.current.delete(id);
      setCollecting((current) => current.filter((other) => other !== id));
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
