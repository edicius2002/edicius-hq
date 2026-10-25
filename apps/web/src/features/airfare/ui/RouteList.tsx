import { useEffect, useRef, useState, type MouseEvent } from 'react';

import {
  formatFlightMonth,
  formatFlightMonths,
  groupRoutePairs,
  hasDeparted,
  monthHasDeparted,
  openingMonth,
  routeId,
  routeMonthKey,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import type { AirfareRequestProgress } from '@/features/airfare/data/airfareRequests';
import { listEdge, type ListEdge } from '@/features/airfare/lib/listEdge';
import { shortMonth } from '@/features/airfare/lib/monthChips';
import { ANALYSIS_PANEL_ID } from '@/features/airfare/ui/AnalysisPanel';
import { RouteEditor } from '@/features/airfare/ui/RouteEditor';
import { RouteTransfer } from '@/features/airfare/ui/RouteTransfer';
import { useReorder } from '@/shared/lib/useReorder';
import { Button } from '@/shared/ui/Button';
import { Skeleton } from '@/shared/ui/Skeleton';

import styles from './RouteList.module.css';

type RouteListProps = {
  routes: FareRoute[];
  /** The colour this route's arc is drawn in, by route id. */
  colours: Map<string, string>;
  selectedId: string | null;
  today: string;
  /** Route-month keys whose own collection is in flight. */
  collecting: readonly string[];
  /** Queue progress by route-month key. */
  progress: ReadonlyMap<string, AirfareRequestProgress>;
  /** Which month of the selected route the chart is reading. */
  activeMonth: string | null;
  /** The watch loaded into the editor above, or null while it is adding. */
  editing: FareRoute | null;
  onSelect: (id: string) => void;
  /**
   * Open one month of one route: select the row, and read that month.
   *
   * One callback rather than two, because a press on a tab means both and a
   * page that had to be told twice could end up selected on one route while
   * reading a month of another.
   */
  onOpenMonth: (id: string, month: string) => void;
  onRemove: (id: string) => void;
  /**
   * Collect one month of this route now.
   *
   * Takes the route rather than its id, unlike `onRemove`: removing is an edit
   * to the stored document and the id is the whole of it, while a collection
   * needs both ends and the currency. The row is holding all of that already,
   * so passing the id would only make the page look it up again.
   *
   * And it takes the **month**, because the row is the only thing that knows
   * which one it is reading — `a-press-collects-the-month-on-screen`. The open
   * tab where this is the open row; the month it would open on where it is not.
   */
  onCollect?: (route: FareRoute, month: string) => void;
  onAdd: (route: FareRoute) => void;
  onSave: (id: string, route: FareRoute) => void;
  /**
   * Put the fields back to adding a route.
   *
   * What a press on the empty part of this panel means. It clears the editor
   * and deliberately **not** the selection: the reader said they were done
   * editing, not that they were done looking at a chart.
   */
  onClearEditing: () => void;
  onMove: (from: string, to: string) => void;
  transferDisabled?: boolean;
  onImported?: () => void | Promise<void>;
  /** The stored document is being read, including a later refresh. */
  loading?: boolean;
  /** A failed read is not an empty watchlist. */
  error?: boolean;
};

/** Floor percentages so a partial phase never appears complete. */
function progressPercent(value: AirfareRequestProgress): string {
  if (value.total === null || value.total <= 0) return '0%';
  return `${Math.min(100, Math.floor((value.completed / value.total) * 100))}%`;
}

/** The idle Fetch icon; active requests show the stage and percentage. */
function CollectMark() {
  return (
    <svg className={styles.mark} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {/* Just under a full turn, so the gap and the head read as a rotation
          rather than as a ring. */}
      <path d="M13.17 9.88A5.5 5.5 0 1 1 11.89 4.11" />
      {/* The head, on the arc's end and pointing the way it travels. */}
      <path d="M8.78 3.54 11.89 4.11 11.32 1" />
    </svg>
  );
}

/**
 * The watchlist, with the fields that add to it standing above it.
 *
 * One panel rather than two, and the fields stay on screen rather than folding
 * away: adding a route is the thing this panel is *for*, and a control that
 * has to be opened before it can be used is one more step in front of the only
 * action here. They are laid out to cost less height than two list entries —
 * origin and destination on one row because they are one decision, the month
 * below because it is the next.
 *
 * **Only the rows scroll** — 12.269, following what 276530a settled for
 * Investing. A watchlist longer than the map beside it used to grow the panel,
 * which grew the grid row they share, which left the map with empty space
 * under it and the page with a scrollbar it had not asked for. The fields stay
 * put, which is the same argument the Investing rail makes: a list long enough
 * to scroll is exactly when you least want the way to add to it scrolled away.
 */
export function RouteList({
  routes,
  colours,
  selectedId,
  today,
  activeMonth,
  editing,
  collecting,
  progress,
  onSelect,
  onOpenMonth,
  onRemove,
  onCollect,
  onAdd,
  onSave,
  onClearEditing,
  onMove,
  transferDisabled = false,
  onImported = () => undefined,
  loading = false,
  error = false,
}: RouteListProps) {
  /*
   * A press on the panel's own background puts the fields back to adding.
   *
   * Without it, choosing a row is a one-way door: the form is holding that
   * watch and the only way back to a blank one is the Cancel button beside the
   * heading, which is a long way from where the reader just pressed. Clicking
   * the empty space below the rows is what everyone tries first.
   *
   * `target === currentTarget` is the whole guard, and it has to be exact
   * rather than a `closest('li')` test: every press inside a row bubbles
   * through here, so anything looser would clear the editor on the way to
   * selecting a route. What passes it is a press that landed on the container
   * itself — the gaps between rows, the space under the last one, the panel's
   * own padding — and nothing else.
   */
  const clearOnBackdrop = (event: MouseEvent) => {
    if (event.target === event.currentTarget) onClearEditing();
  };
  // Order is not decoration here: the collector spends its daily request
  // budget down the list, so dragging a route to the top says "poll this one
  // first when there is not enough budget for everything".
  const routeGroups = groupRoutePairs(routes);
  const { dragging, rowProps } = useReorder({
    order: routeGroups.map((group) => routeId(group[0])),
    onMove,
  });

  /*
   * Whether there are rows above or below the ones on screen — 12.259.
   *
   * Read rather than assumed, because a mark drawn unconditionally is the page
   * claiming rows it does not have the moment the reader reaches the bottom.
   * The rule is `listEdge`, which is three numbers and a word and has its own
   * suite; all this does is ask it and put the answer where the stylesheet can
   * see it.
   *
   * Re-measured on scroll and whenever the list's own box changes. The
   * `ResizeObserver` is on the scroller rather than on the rows: the panel
   * shares a height with the map beside it, so the box moves when the window
   * does, and a mark left over from a taller box would outlive the overflow it
   * was drawn for. Content growth comes through the effect's dependencies
   * instead — a scroll container's border box does not change when a row is
   * added to it, so nothing would observe that.
   */
  const scroller = useRef<HTMLUListElement>(null);
  const [edge, setEdge] = useState<ListEdge>('none');
  useEffect(() => {
    const node = scroller.current;
    if (!node) {
      setEdge('none');
      return;
    }
    const measure = () => setEdge(listEdge(node));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [routes, loading]);

  const visibleGroups = loading ? [] : routeGroups;
  const visibleRows = Array.from({ length: Math.ceil(visibleGroups.length / 2) }, (_, index) =>
    visibleGroups.slice(index * 2, index * 2 + 2),
  );

  return (
    <div className={styles.panel} onClick={clearOnBackdrop}>
      {/*
        Keyed on the watch being edited, so choosing another row **remounts**
        the form and the fields reload from it. That is `PositionForm`'s
        behaviour by construction — the parent renders a different form per row
        — and deliberately not an effect syncing props into state, which is the
        stale-read this codebase has avoided everywhere else. The cost is a
        discarded draft when the reader clicks a row mid-typing; the draft is
        two codes and a chip set, and the alternative needs a dialog this app
        does not have.
      */}
      <RouteEditor
        key={editing ? routeId(editing) : 'new'}
        today={today}
        editing={editing}
        watched={routes.map(routeId)}
        onAdd={onAdd}
        onSave={onSave}
      />

      {error && routes.length === 0 ? (
        <p className={styles.empty} role="alert">
          Could not load watched routes. Reload to try again.
        </p>
      ) : !loading && routes.length === 0 ? (
        <p className={styles.empty} onClick={clearOnBackdrop}>
          No routes watched yet.
        </p>
      ) : (
        /*
          The box the marks are drawn on, which cannot be the scroller itself:
          a pseudo-element of a scroll container scrolls with its content, and
          a mark pinned to the bottom edge has to stay at the bottom edge.
        */
        <div
          className={styles.listBox}
          data-edge={loading ? 'none' : edge}
          onClick={clearOnBackdrop}
          role={loading ? 'status' : undefined}
          aria-label={loading ? 'Loading watched routes' : undefined}
        >
          {loading ? <span className={styles.sr}>Loading watched routes</span> : null}
          <ul
            className={styles.list}
            ref={scroller}
            onClick={clearOnBackdrop}
            onScroll={(event) => setEdge(listEdge(event.currentTarget))}
            /*
              Reachable by keyboard, and this is the reason for both
              attributes. The rows hold buttons, so Tab does walk into the list
              and the browser scrolls to follow — but that is the only way in,
              and a reader who is reading rather than operating has none. A
              tab stop on the scroller itself gives them the arrow keys, at the
              cost of one stop before the first row, which is the trade every
              scrollable region makes. The name is what that stop announces;
              without it a screen reader reaches an unnamed box.
            */
            tabIndex={loading ? -1 : 0}
            aria-hidden={loading || undefined}
            aria-label="Watched routes"
          >
            {loading
              ? Array.from({ length: 10 }, (_, index) => (
                  <li className={styles.skeletonRow} data-testid="route-skeleton" key={index}>
                    <Skeleton width="40%" height={28} />
                    <Skeleton width="34%" height={24} />
                    <Skeleton width="18%" height={24} />
                  </li>
                ))
              : null}
            {visibleRows.map((groups) => {
              const firstId = routeId(groups[0][0]);
              const targetGroup =
                groups.find((group) => group.some((route) => routeId(route) === selectedId)) ??
                groups[0];
              const targetRoute =
                targetGroup.find((route) => routeId(route) === selectedId) ?? targetGroup[0];
              const targetId = routeId(targetRoute);
              const targetMonth =
                targetId === selectedId &&
                activeMonth !== null &&
                targetRoute.months.includes(activeMonth)
                  ? activeMonth
                  : openingMonth(targetRoute, today);
              const key = routeMonthKey(targetRoute, targetMonth);
              const busy = collecting.includes(key);
              const stage = progress.get(key);

              return (
                <li key={firstId} className={styles.item}>
                  <div className={styles.row}>
                    {groups.map((group) => {
                      const groupId = routeId(group[0]);
                      const route =
                        group.find((candidate) => routeId(candidate) === selectedId) ?? group[0];
                      const id = routeId(route);
                      const inverse = group.find((candidate) => routeId(candidate) !== id);
                      const drawn = [
                        ...new Set(group.flatMap((candidate) => candidate.months)),
                      ].sort();
                      const reading =
                        id === selectedId &&
                        activeMonth !== null &&
                        route.months.includes(activeMonth)
                          ? activeMonth
                          : openingMonth(route, today);
                      const tabStop = route.months.includes(reading) ? reading : route.months[0];
                      const monthsLabel = inverse
                        ? routeLabel(route) +
                          ': ' +
                          formatFlightMonths(route.months) +
                          '; ' +
                          routeLabel(inverse) +
                          ': ' +
                          formatFlightMonths(inverse.months)
                        : formatFlightMonths(route.months);
                      return (
                        <div
                          key={groupId}
                          className={
                            dragging === groupId
                              ? styles.routeCell + ' ' + styles.dragging
                              : styles.routeCell
                          }
                          {...rowProps(groupId)}
                        >
                          <button
                            type="button"
                            className={
                              id === selectedId
                                ? styles.route + ' ' + styles.selected
                                : styles.route
                            }
                            aria-current={id === selectedId ? 'true' : undefined}
                            onClick={() =>
                              onSelect(id === selectedId && inverse ? routeId(inverse) : id)
                            }
                            title={
                              id === selectedId && inverse
                                ? 'Switch to ' + routeLabel(inverse)
                                : undefined
                            }
                          >
                            <span
                              className={styles.swatch}
                              style={{ background: colours.get(id) ?? 'var(--color-muted)' }}
                              aria-hidden="true"
                            />
                            <span className={styles.pair}>
                              {route.origin}{' '}
                              <span className={styles.to} aria-hidden="true">
                                →
                              </span>
                              <span className={styles.sr}>to</span> {route.destination}
                            </span>
                          </button>
                          <span
                            className={styles.months}
                            role="group"
                            aria-label={'Months watched for ' + routeLabel(route)}
                            title={monthsLabel}
                            onKeyDown={(event) => {
                              if (event.altKey) return;
                              const step =
                                event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
                              if (step === 0) return;
                              event.preventDefault();
                              const next = route.months[route.months.indexOf(tabStop) + step];
                              if (next !== undefined) onOpenMonth(id, next);
                            }}
                          >
                            {drawn.map((month) => {
                              const open = id === selectedId && month === activeMonth;
                              const inverseOnly = !route.months.includes(month);
                              return (
                                <button
                                  key={month}
                                  type="button"
                                  className={[
                                    styles.monthTab,
                                    open ? styles.monthTabOpen : '',
                                    monthHasDeparted(month, today) ? styles.monthTabGone : '',
                                    inverseOnly ? styles.monthTabInverse : '',
                                  ]
                                    .filter(Boolean)
                                    .join(' ')}
                                  aria-label={
                                    inverseOnly
                                      ? formatFlightMonth(month) +
                                        ' — ' +
                                        routeLabel(inverse!) +
                                        ' only'
                                      : monthHasDeparted(month, today)
                                        ? formatFlightMonth(month) + ' — departed'
                                        : formatFlightMonth(month)
                                  }
                                  aria-current={open ? 'true' : undefined}
                                  aria-controls={inverseOnly ? undefined : ANALYSIS_PANEL_ID}
                                  tabIndex={!inverseOnly && month === tabStop ? 0 : -1}
                                  disabled={inverseOnly}
                                  onClick={() => onOpenMonth(id, month)}
                                >
                                  {shortMonth(month)}
                                </button>
                              );
                            })}
                          </span>
                          {hasDeparted(route, today) ? (
                            <span className={styles.departed}>Departed</span>
                          ) : null}
                        </div>
                      );
                    })}
                    <div className={styles.actions}>
                      {hasDeparted(targetRoute, today) || !onCollect ? null : (
                        <Button
                          variant="ghost"
                          size="small"
                          className={styles.collect}
                          onClick={() => onCollect(targetRoute, targetMonth)}
                          disabled={busy}
                          aria-busy={busy || undefined}
                          aria-label={
                            busy
                              ? 'Fetching ' +
                                routeLabel(targetRoute) +
                                ', ' +
                                formatFlightMonth(targetMonth) +
                                ', ' +
                                (stage?.stage === 'syncing'
                                  ? 'syncing '
                                  : stage?.stage === 'collecting'
                                    ? 'downloading '
                                    : 'queued ') +
                                progressPercent(
                                  stage ?? { stage: 'queued', completed: 0, total: null },
                                )
                              : 'Fetch ' +
                                routeLabel(targetRoute) +
                                ' now, ' +
                                formatFlightMonth(targetMonth)
                          }
                        >
                          {busy ? (
                            <span className={styles.fetchProgress} aria-hidden="true">
                              {stage?.stage === 'syncing' ? '↑' : '↓'}{' '}
                              {progressPercent(
                                stage ?? {
                                  stage: 'queued',
                                  completed: 0,
                                  total: null,
                                },
                              )}
                            </span>
                          ) : (
                            <CollectMark />
                          )}
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="small"
                        className={styles.remove}
                        onClick={() => onRemove(targetId)}
                        aria-label={'Stop watching ' + routeLabel(targetRoute)}
                        title={'Remove ' + routeLabel(targetRoute)}
                      >
                        <svg
                          className={styles.trashIcon}
                          viewBox="0 0 16 16"
                          aria-hidden="true"
                          focusable="false"
                        >
                          <path d="M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5M6.5 7v3.5M9.5 7v3.5" />
                        </svg>
                      </Button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}
      <RouteTransfer disabled={transferDisabled} onImported={onImported} />
    </div>
  );
}
