import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  enqueueAirfareRequest,
  fetchActiveAirfareRequests,
  fetchAirfareRequest,
  subscribeAirfareRequests,
  type AirfareRequest,
} from '@/features/airfare/data/airfareRequests';
import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import {
  NOTICE_LIFE_MS,
  acceptedCollectNotice,
  terminalCollectNotice,
  withNotice,
  type CollectNotice,
} from '@/features/airfare/lib/collectNotice';
import type { PassProgress } from '@/features/airfare/lib/passProgress';

const RECONCILE_MS = 5_000;

export type RouteCollection = {
  collecting: readonly string[];
  progress: ReadonlyMap<string, PassProgress>;
  notices: readonly CollectNotice[];
  collect: (route: FareRoute, month: string) => void;
  forget: (id: string) => void;
};

export function useRouteCollection(): RouteCollection {
  const client = useQueryClient();
  const [requests, setRequests] = useState<ReadonlyMap<string, AirfareRequest>>(() => new Map());
  const [notices, setNotices] = useState<readonly CollectNotice[]>([]);
  const requestsRef = useRef(new Map<string, AirfareRequest>());
  const adopted = useRef(new Set<string>());
  const handledTerminal = useRef(new Set<string>());
  const forgottenRoutes = useRef(new Set<string>());
  const noticeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  const showNotice = useCallback((notice: CollectNotice) => {
    setNotices((current) => withNotice(current, notice));
    const previous = noticeTimers.current.get(notice.id);
    if (previous) clearTimeout(previous);
    noticeTimers.current.set(
      notice.id,
      setTimeout(() => {
        setNotices((current) => current.filter((item) => item.id !== notice.id));
        noticeTimers.current.delete(notice.id);
      }, NOTICE_LIFE_MS),
    );
  }, []);

  const accept = useCallback(
    (incoming: AirfareRequest) => {
      const request =
        (incoming.status === 'queued' || incoming.status === 'running') &&
        Date.parse(incoming.expiresAt) <= Date.now()
          ? { ...incoming, status: 'expired' as const }
          : incoming;
      const route = requestRouteId(request);
      if (forgottenRoutes.current.has(route)) return;
      const active = request.status === 'queued' || request.status === 'running';
      if (active) adopted.current.add(request.requestId);
      if (!active && !adopted.current.has(request.requestId)) return;

      requestsRef.current.set(request.requestId, request);
      setRequests(new Map(requestsRef.current));
      if (active || handledTerminal.current.has(request.requestId)) return;

      handledTerminal.current.add(request.requestId);
      const notice = terminalCollectNotice(request);
      if (notice) showNotice(notice);
      if (request.status !== 'complete') return;
      for (const queryKey of [
        ['fares', 'history', request.payload.origin, request.payload.destination],
        ['fares', 'projection', request.payload.origin, request.payload.destination],
        ['fares', 'flightPage', request.payload.origin, request.payload.destination],
        ['fares', 'calendar', request.payload.origin, request.payload.destination],
        ['fares', 'airports'],
      ]) {
        void client.invalidateQueries({ queryKey });
      }
    },
    [client, showNotice],
  );

  useEffect(() => {
    let disposed = false;
    const reconcile = async () => {
      try {
        const active = await fetchActiveAirfareRequests();
        if (disposed) return;
        const activeIds = new Set(active.map((request) => request.requestId));
        active.forEach(accept);
        const missing = [...adopted.current].filter((id) => {
          const known = requestsRef.current.get(id);
          return (
            !activeIds.has(id) &&
            known !== undefined &&
            (known.status === 'queued' || known.status === 'running')
          );
        });
        const settled = await Promise.all(missing.map((id) => fetchAirfareRequest(id)));
        if (!disposed) settled.forEach((request) => request && accept(request));
      } catch {
        // Realtime and the next bounded poll remain available.
      }
    };
    const unsubscribe = subscribeAirfareRequests(accept);
    void reconcile();
    const timer = setInterval(() => void reconcile(), RECONCILE_MS);
    return () => {
      disposed = true;
      clearInterval(timer);
      unsubscribe();
    };
  }, [accept]);

  useEffect(
    () => () => {
      noticeTimers.current.forEach(clearTimeout);
      noticeTimers.current.clear();
    },
    [],
  );

  const collect = useCallback(
    (route: FareRoute, month: string) => {
      forgottenRoutes.current.delete(routeId(route));
      void enqueueAirfareRequest({
        origin: route.origin,
        destination: route.destination,
        month,
        currency: route.currency,
      })
        .then((request) => {
          accept(request);
          showNotice(acceptedCollectNotice(request));
        })
        .catch(() => {
          const id = `enqueue-${route.origin}-${route.destination}-${month}`;
          showNotice({
            id,
            routeId: routeId(route),
            title: `${route.origin} → ${route.destination}`,
            text: 'Collection request could not be accepted. Try again.',
            kind: 'error',
          });
        });
    },
    [accept, showNotice],
  );

  const forget = useCallback((id: string) => {
    forgottenRoutes.current.add(id);
    for (const [requestId, request] of requestsRef.current) {
      if (requestRouteId(request) !== id) continue;
      requestsRef.current.delete(requestId);
      adopted.current.delete(requestId);
    }
    setRequests(new Map(requestsRef.current));
    setNotices((current) => {
      for (const notice of current) {
        if (notice.routeId !== id) continue;
        const timer = noticeTimers.current.get(notice.id);
        if (timer) clearTimeout(timer);
        noticeTimers.current.delete(notice.id);
      }
      return current.filter((notice) => notice.routeId !== id);
    });
  }, []);

  const { collecting, progress } = useMemo(() => deriveActiveState(requests), [requests]);
  return { collecting, progress, notices, collect, forget };
}

function deriveActiveState(requests: ReadonlyMap<string, AirfareRequest>): {
  collecting: readonly string[];
  progress: ReadonlyMap<string, PassProgress>;
} {
  const collecting: string[] = [];
  const progress = new Map<string, PassProgress>();
  for (const request of requests.values()) {
    if (request.status !== 'queued' && request.status !== 'running') continue;
    const id = requestRouteId(request);
    if (!collecting.includes(id)) collecting.push(id);
    const { stage, completed, total } = request.progress;
    if (stage === 'syncing') {
      const polling = total && total > 0 ? total : Math.max(completed, 1);
      progress.set(id, { completed: polling, polling, fraction: 1 });
    } else if (stage === 'queued' || total === null || total === 0) {
      progress.set(id, { completed, polling: null, fraction: null });
    } else {
      const clamped = Math.min(completed, total);
      progress.set(id, { completed: clamped, polling: total, fraction: clamped / total });
    }
  }
  return { collecting, progress };
}

/**
 * The watchlist's own key for the route a request collects.
 *
 * Rows, the map and the page look routes up by `routeId`; a request keyed any
 * other way is progress no row can find, which is how the bar went missing.
 */
function requestRouteId(request: AirfareRequest): string {
  return routeId(request.payload);
}
