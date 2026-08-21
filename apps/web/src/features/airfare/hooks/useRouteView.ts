import { useCallback, useMemo, useState } from 'react';

import { periodBounds, type Granularity } from '@/features/airfare/lib/buckets';
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
 * Where a route that has never been opened starts: the whole watched month, on
 * the month it is watched for, and nothing hidden —
 * `a-watch-opens-on-its-own-month`.
 *
 * It was `day`, on the grounds that a day is the only period the collector's own
 * cadence can fill and a route with one pass behind it has nothing a week could
 * average. That argument was about chart A, and 12.242 took chart A off this
 * value altogether — it is drawn by day and by nothing else now. What is left
 * pointed at is chart B, whose x axis is *departure* time, and there the
 * collector's cadence decides nothing: one pass brings back the board for every
 * day of the month at once, so the month is full from the first pass and the day
 * view is one thirty-first of what was collected.
 *
 * **The anchor is the first of that month, and it is not decoration.** An anchor
 * is a departure day, and at month granularity `activeKey` uses it for one
 * thing: `bucketKey` it and see whether that month is a period the frame can
 * reach. Left null the frame falls back to the earliest thing on the axis, which
 * is the boards' first day only *once the history request has landed* — before
 * that the boards are empty and the earliest thing on the axis is the booking
 * horizon's first month, which is this month rather than the watched one. So a
 * null anchor opens a March watch on August and jumps to March a moment later.
 * Naming the month up front is what stops that, and it costs nothing when the
 * boards are there, because the first of the month buckets to the same month
 * they do.
 *
 * The date comes from `periodBounds` rather than from `${month}-01`, because
 * that function is this feature's single answer to "what does a key cover" and a
 * second one here is how the chart and the table come to disagree about a
 * period.
 */
export function openingView(month: string | null): RouteView {
  return {
    granularity: 'month',
    // Null only for the no-route slot, which has no month to open on.
    anchor: month === null ? null : periodBounds(month, 'month').from.slice(0, 10),
    viewport: null,
  };
}

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

/**
 * @param routeKey Which route's reading is wanted, or null for the empty page.
 * @param month The month that route is watched for, which is what it opens on.
 *
 * `month` is a second argument rather than something read out of `routeKey` —
 * which does carry it, `routeId` being `origin|destination|month`. Splitting a
 * key back apart would make the opening month depend on the *format* of an id,
 * so a change to how routes are named would silently move which month every
 * watch opens on, with nothing in either file mentioning the other.
 *
 * **It seeds the record and never overwrites one.** The opening view is the
 * fallback for a key this hook has not been written for; the moment the reader
 * touches the period switch there is a record under that key and it is returned
 * unchanged from then on, including after a walk to another watch and back. That
 * is why this is a value read at lookup rather than an effect that writes: an
 * effect would have to decide, every render, whether the record it is looking at
 * is a reader's choice or its own seed, and would rewrite the reader's choice
 * the first time it got that wrong.
 */
export function useRouteView(
  routeKey: string | null,
  month: string | null,
): {
  view: RouteView;
  setGranularity: (granularity: Granularity) => void;
  setAnchor: (anchor: string | null) => void;
  setViewport: (viewport: Viewport | null) => void;
} {
  const [views, setViews] = useState<Record<string, RouteView>>({});
  const key = routeKey ?? NO_ROUTE;
  const opening = useMemo(() => openingView(month), [month]);
  const view = views[key] ?? opening;

  const write = useCallback(
    (change: (held: RouteView) => RouteView) => {
      setViews((held) => ({ ...held, [key]: change(held[key] ?? opening) }));
    },
    [key, opening],
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
