import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  enqueueAirfareRequest,
  fetchActiveAirfareRequests,
  fetchAirfareRequest,
  subscribeAirfareRequests,
  type AirfareRequest,
  type AirfareRequestProgress,
} from '@/features/airfare/data/airfareRequests';
import { routeId, routeMonthKey, type FareRoute } from '@/features/airfare/data/fareRoutes';
import {
  NOTICE_LIFE_MS,
  acceptedCollectNotice,
  terminalCollectNotice,
  withNotice,
  type CollectNotice,
} from '@/features/airfare/lib/collectNotice';

const RECONCILE_MS = 5_000;
const IDLE_RECONCILE_MS = 60_000;

export type RouteCollection = {
  collecting: readonly string[];
  progress: ReadonlyMap<string, AirfareRequestProgress>;
  notices: readonly CollectNotice[];
  collect: (route: FareRoute, month: string) => void;
  forget: (id: string) => void;
};

export function useRouteCollection(): RouteCollection {
  const client = useQueryClient();
  const [requests, setRequests] = useState<ReadonlyMap<string, AirfareRequest>>(() => new Map());
  const [pending, setPending] = useState<ReadonlySet<string>>(() => new Set());
  const [notices, setNotices] = useState<readonly CollectNotice[]>([]);
  const requestsRef = useRef(new Map<string, AirfareRequest>());
  const pendingRef = useRef(new Set<string>());
  const adopted = useRef(new Set<string>());
  const handledTerminal = useRef(new Set<string>());
  const forgottenRoutes = useRef(new Set<string>());
  const noticeTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const reconcileRef = useRef<() => Promise<void>>(async () => {});
  const { collecting, progress } = useMemo(
    () => deriveActiveState(requests, pending),
    [requests, pending],
  );

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
      const key = requestMonthKey(request);
      if (pendingRef.current.delete(key)) setPending(new Set(pendingRef.current));
      const active = request.status === 'queued' || request.status === 'running';
      const previous = requestsRef.current.get(request.requestId);
      if (
        previous?.status === 'complete' ||
        ((previous?.status === 'failed' || previous?.status === 'expired') && active)
      )
        return;
      // A server completion can arrive after the local expiry clock fires.
      // The confirmed completion must still refresh the fare queries.
      if (previous?.status === 'expired' && request.status === 'complete')
        handledTerminal.current.delete(request.requestId);
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
    reconcileRef.current = reconcile;
    const unsubscribe = subscribeAirfareRequests(accept);
    void reconcile();
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [accept]);

  useEffect(() => {
    const timer = setInterval(
      () => void reconcileRef.current(),
      collecting.length > 0 ? RECONCILE_MS : IDLE_RECONCILE_MS,
    );
    return () => clearInterval(timer);
  }, [collecting.length]);

  useEffect(() => {
    const next = [...requests.values()]
      .filter((request) => request.status === 'queued' || request.status === 'running')
      .sort((a, b) => Date.parse(a.expiresAt) - Date.parse(b.expiresAt))[0];
    if (!next) return;
    const delay = Math.min(2_147_483_647, Math.max(0, Date.parse(next.expiresAt) - Date.now() + 1));
    const timer = setTimeout(() => accept(next), delay);
    return () => clearTimeout(timer);
  }, [accept, requests]);

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
      const key = routeMonthKey(route, month);
      if (
        pendingRef.current.has(key) ||
        [...requestsRef.current.values()].some(
          (request) =>
            requestMonthKey(request) === key &&
            (request.status === 'queued' || request.status === 'running'),
        )
      )
        return;
      pendingRef.current.add(key);
      setPending(new Set(pendingRef.current));
      void enqueueAirfareRequest({
        origin: route.origin,
        destination: route.destination,
        month,
        currency: route.currency,
      })
        .then((request) => {
          accept(request);
          if (!forgottenRoutes.current.has(routeId(route)))
            showNotice(acceptedCollectNotice(request));
        })
        .catch(() => {
          pendingRef.current.delete(key);
          setPending(new Set(pendingRef.current));
          if (forgottenRoutes.current.has(routeId(route))) return;
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
    for (const key of pendingRef.current) {
      if (key.startsWith(`${id}|`)) pendingRef.current.delete(key);
    }
    setPending(new Set(pendingRef.current));
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

  return { collecting, progress, notices, collect, forget };
}

function deriveActiveState(
  requests: ReadonlyMap<string, AirfareRequest>,
  pending: ReadonlySet<string>,
): {
  collecting: readonly string[];
  progress: ReadonlyMap<string, AirfareRequestProgress>;
} {
  const collecting = [...pending];
  const progress = new Map<string, AirfareRequestProgress>();
  for (const key of pending) progress.set(key, { stage: 'queued', completed: 0, total: null });
  for (const request of requests.values()) {
    if (request.status !== 'queued' && request.status !== 'running') continue;
    const key = requestMonthKey(request);
    if (!collecting.includes(key)) collecting.push(key);
    progress.set(key, request.progress);
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

function requestMonthKey(request: AirfareRequest): string {
  return routeMonthKey(request.payload, request.payload.month);
}
