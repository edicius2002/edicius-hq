import { useCallback, useState } from 'react';

import type { Granularity } from '@/features/airfare/lib/buckets';
import type { Viewport } from '@/features/airfare/lib/viewport';

/**
 * How a reader last left one route's departure chart, kept per route for the
 * session.
 *
 * **Three values rather than three hooks**, because they are only meaningful
 * together. A viewport is minutes *into a period*, and which period that is
 * comes from the granularity and the anchor — so a granularity restored without
 * its viewport, or a viewport restored against a period that has moved, is a
 * zoom into a stretch of time the reader never chose. Stored as one record they
 * cannot be restored out of step with each other.
 *
 * **Per route, because a watch is what the reader is comparing.** The
 * granularity used to be one value for the whole page and the anchor was
 * cleared outright on every route change (the reason 12.143 gives — an index
 * into a rebuilt list of periods points at the wrong day). Clearing it was the
 * right answer while there was nothing to restore it *to*; a route that
 * remembers its own reading does not need to be cleared, it needs to be looked
 * up. So this replaces the clearing rather than sitting beside it.
 *
 * **In memory, and only for the session.** There is no client-side store in
 * this app — no `localStorage` anywhere — and the only key-value facade is
 * `shared/api/kv`, which is an HTTP round-trip to the API and lands in
 * `.local-data`. A camera position changes on every wheel notch, so writing it
 * there would be a request per notch against the file the collector's archive
 * lives in. Surviving a reload is worth having and is not worth that; it wants
 * a client store this app has not needed yet.
 */
export type RouteView = {
  granularity: Granularity;
  /** The departure day the frame is anchored on, or null for the earliest the archive holds. */
  anchor: string | null;
  /** How much of the frame is on screen, or null for the whole of it. */
  viewport: Viewport | null;
};

/**
 * Where a route that has never been opened starts: a day at a time, the
 * earliest departure the boards hold, and nothing hidden.
 *
 * `day` because it is the only period the collector's own cadence can fill, and
 * a route with one collection pass behind it has nothing a week could average.
 */
const DEFAULT_VIEW: RouteView = { granularity: 'day', anchor: null, viewport: null };

/**
 * The slot used while no route is selected.
 *
 * A route id can never be the empty string — `routeId` joins three non-empty
 * fields — so this cannot collide with a real one. It exists so the period
 * switch still works on an empty page: a control that silently did nothing
 * because there was no route to write against would be the page lying about
 * what it can do.
 */
const NO_ROUTE = '';

export function useRouteView(routeKey: string | null): {
  view: RouteView;
  setGranularity: (granularity: Granularity) => void;
  setAnchor: (anchor: string | null) => void;
  setViewport: (viewport: Viewport | null) => void;
} {
  const [views, setViews] = useState<Record<string, RouteView>>({});
  const key = routeKey ?? NO_ROUTE;
  const view = views[key] ?? DEFAULT_VIEW;

  const write = useCallback(
    (change: (held: RouteView) => RouteView) => {
      setViews((held) => ({ ...held, [key]: change(held[key] ?? DEFAULT_VIEW) }));
    },
    [key],
  );

  /*
   * A new granularity drops the viewport, and that is the one place a stored
   * zoom is *not* carried.
   *
   * A day, a week and a month are frames of different lengths, so the same
   * "minutes 600 to 900" is the morning of one date in the first and a stretch
   * of the first day in the last. Clamping it would keep it legal and still
   * leave the reader somewhere they never asked to be, which is worse than
   * being returned to the whole frame.
   *
   * The anchor survives, because it is a *day* rather than an index — 12.143 —
   * and a day means the same thing at every period.
   */
  const setGranularity = useCallback(
    (granularity: Granularity) =>
      write((held) =>
        held.granularity === granularity ? held : { ...held, granularity, viewport: null },
      ),
    [write],
  );

  const setAnchor = useCallback(
    (anchor: string | null) =>
      write((held) => (held.anchor === anchor ? held : { ...held, anchor })),
    [write],
  );

  const setViewport = useCallback(
    (viewport: Viewport | null) => write((held) => ({ ...held, viewport })),
    [write],
  );

  return { view, setGranularity, setAnchor, setViewport };
}
