import { formatFlightMonth, routeId, routeLabel } from '@/features/airfare/data/fareRoutes';
import type { AirfareRequest } from '@/features/airfare/data/airfareRequests';

export const NOTICE_LIFE_MS = 10_000;
export const MAX_NOTICES = 3;

export type CollectNotice = {
  /** Request id: an accepted card is replaced by its own terminal outcome. */
  id: string;
  /** Route id: lets removing a watch also remove its transient cards. */
  routeId: string;
  title: string;
  text: string;
  /** What a completed pass missed — only on a `partial` card. */
  detail?: string;
  kind: 'accepted' | 'success' | 'partial' | 'error';
};

export function acceptedCollectNotice(request: AirfareRequest): CollectNotice {
  return notice(request, 'accepted', 'Collection request accepted by the Pi.');
}

export function terminalCollectNotice(request: AirfareRequest): CollectNotice | null {
  if (request.status === 'complete' && request.result) {
    const { lookedAt, changed, failed, skipped } = request.result;
    const text = `Collection complete: ${lookedAt} departures checked, ${changed} updated.`;
    // A pass keeps what it read even when some departures could not be read or
    // were not polled; the card says so rather than calling it a clean success.
    const missed = [
      ...(failed > 0 ? [`${failed} couldn't be read`] : []),
      ...(skipped > 0 ? [`${skipped} skipped`] : []),
    ];
    if (missed.length === 0) return notice(request, 'success', text);
    return { ...notice(request, 'partial', text), detail: `${missed.join(', ')}.` };
  }
  if (request.status === 'failed') {
    return notice(request, 'error', 'Collection failed. Try again.');
  }
  if (request.status === 'expired') {
    return notice(request, 'error', 'Collection request expired. Try again.');
  }
  return null;
}

export function withNotice(
  current: readonly CollectNotice[],
  next: CollectNotice,
): readonly CollectNotice[] {
  return [...current.filter((notice) => notice.id !== next.id), next].slice(-MAX_NOTICES);
}

export function withoutNotice(
  current: readonly CollectNotice[],
  id: string,
): readonly CollectNotice[] {
  const kept = current.filter((notice) => notice.id !== id);
  return kept.length === current.length ? current : kept;
}

function notice(request: AirfareRequest, kind: CollectNotice['kind'], text: string): CollectNotice {
  const route = {
    origin: request.payload.origin,
    destination: request.payload.destination,
  };
  return {
    id: request.requestId,
    routeId: routeId(route),
    title: `${routeLabel(route)} · ${formatFlightMonth(request.payload.month)}`,
    text,
    kind,
  };
}
