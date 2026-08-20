import { useEffect, useRef, useState } from 'react';

import {
  formatFlightMonth,
  monthOf,
  routeId,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
import { listEdge, type ListEdge } from '@/features/airfare/lib/listEdge';
import type { RowReport } from '@/features/airfare/lib/rowReport';
import { RouteEditor } from '@/features/airfare/ui/RouteEditor';
import { useReorder } from '@/shared/lib/useReorder';
import { Button } from '@/shared/ui/Button';

import styles from './RouteList.module.css';

type RouteListProps = {
  routes: FareRoute[];
  /** The colour this route's arc is drawn in, by route id. */
  colours: Map<string, string>;
  selectedId: string | null;
  today: string;
  /** Route ids whose own collection is in flight. Never more than a few. */
  collecting: readonly string[];
  /** What the last press on a row came back with, by route id. */
  reports: ReadonlyMap<string, RowReport>;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  /**
   * Collect this one route now.
   *
   * Takes the route rather than its id, unlike `onRemove`: removing is an edit
   * to the stored document and the id is the whole of it, while a collection
   * needs both ends, the month and the currency. The row is holding all of
   * that already, so passing the id would only make the page look it up again.
   */
  onCollect: (route: FareRoute) => void;
  onAdd: (route: FareRoute) => void;
  onMove: (from: string, to: string) => void;
};

/**
 * The collect control's mark: a circular arrow, drawn rather than typed.
 *
 * The row's other arrows are text — `→`, `↑`, `↓` — and a `↻` would have
 * matched them for a character of width. It is not typed because this app
 * ships no font file: `fonts.css` reaches for a locally installed Berkeley
 * Mono and otherwise falls through to whatever monospace the machine has, and
 * a glyph one of those fallbacks lacks renders as a box. The row's existing
 * arrows are in the part of the arrows block every monospace font covers; a
 * rotation arrow is not, and a tofu box beside Remove is worse than an inline
 * path that cannot fail.
 *
 * It spins only while its own request is in flight, in CSS, so an idle
 * watchlist animates nothing.
 */
function CollectMark({ busy }: { busy: boolean }) {
  return (
    <svg
      className={busy ? `${styles.mark} ${styles.spinning}` : styles.mark}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
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
  collecting,
  reports,
  onSelect,
  onRemove,
  onCollect,
  onAdd,
  onMove,
}: RouteListProps) {
  // Order is not decoration here: the collector spends its daily request
  // budget down the list, so dragging a route to the top says "poll this one
  // first when there is not enough budget for everything".
  const { dragging, rowProps } = useReorder({
    order: routes.map(routeId),
    onMove,
  });

  /*
   * Whether there are rows above or below the ones on screen — 12.270.
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
  }, [routes, reports]);

  return (
    <div className={styles.panel}>
      <RouteEditor today={today} onAdd={onAdd} />

      {routes.length === 0 ? (
        <p className={styles.empty}>No routes watched yet.</p>
      ) : (
        /*
          The box the marks are drawn on, which cannot be the scroller itself:
          a pseudo-element of a scroll container scrolls with its content, and
          a mark pinned to the bottom edge has to stay at the bottom edge.
        */
        <div className={styles.listBox} data-edge={edge}>
          <ul
            className={styles.list}
            ref={scroller}
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
            tabIndex={0}
            aria-label="Watched routes"
          >
            {routes.map((route) => {
              const id = routeId(route);
              // A month is over only once the calendar has left it. Half a month
              // can be in the past and the rest still worth collecting, which is
              // a distinction the collector draws day by day and this row cannot.
              const departed = route.month < monthOf(today);
              const busy = collecting.includes(id);
              const report = reports.get(id) ?? null;
              return (
                <li
                  key={id}
                  className={`${styles.item} ${dragging === id ? styles.dragging : ''}`}
                  {...rowProps(id)}
                >
                  <div className={styles.row}>
                    <button
                      type="button"
                      className={
                        id === selectedId ? `${styles.route} ${styles.selected}` : styles.route
                      }
                      aria-current={id === selectedId ? 'true' : undefined}
                      onClick={() => onSelect(id)}
                    >
                      {/*
                      The colour this route is drawn in on the map. Eight arcs
                      leave Lima together, and without this the reader has no
                      way to tell which line is the row they are looking at.
                    */}
                      <span
                        className={styles.swatch}
                        style={{ background: colours.get(id) ?? 'var(--color-muted)' }}
                        aria-hidden="true"
                      />
                      {/*
                      Split so the arrow can be smaller and quieter than the
                      two codes — it is punctuation, not information. Read
                      aloud it becomes the word, because "LIM right-arrow CUZ"
                      is not how anyone says a route.
                    */}
                      <span className={styles.pair}>
                        {route.origin}{' '}
                        <span className={styles.to} aria-hidden="true">
                          →
                        </span>
                        <span className={styles.sr}>to</span> {route.destination}
                      </span>
                      <span className={styles.dates}>
                        {/*
                        One leg where there used to be two: 12.113 dropped the
                        return, and 12.110 made the remaining one a month. The
                        arrow stays hidden from the accessibility tree with the
                        word carried beside it, because "up arrow March 2027"
                        is not what a departure sounds like.
                      */}
                        <span className={styles.leg}>
                          <span className={styles.arrow} aria-hidden="true">
                            ↑
                          </span>
                          <span className={styles.sr}>departs in</span>
                          {formatFlightMonth(route.month)}
                        </span>
                      </span>
                      {/*
                      A month that has been and gone keeps its history — that
                      is the point of an archive — but nothing more will be
                      collected for it, and saying so is cheaper than letting
                      the reader wonder why its series stopped.
                    */}
                      {departed ? <span className={styles.departed}>Departed</span> : null}
                    </button>
                    {/*
                    Collect this one route, now, without waiting for a pass
                    over the whole list. Absent rather than disabled on a
                    departed route: the provider answers nothing about a flight
                    that has left, so there is no press to invite — the row
                    already says "Departed", and a greyed control beside it
                    would only make the reader wonder what would happen.
                  */}
                    {departed ? null : (
                      <Button
                        variant="ghost"
                        size="small"
                        className={styles.collect}
                        onClick={() => onCollect(route)}
                        disabled={busy}
                        aria-busy={busy || undefined}
                        aria-label={
                          busy
                            ? `Collecting ${routeLabel(route)} in ${formatFlightMonth(route.month)}`
                            : `Collect ${routeLabel(route)} in ${formatFlightMonth(route.month)} now`
                        }
                      >
                        <CollectMark busy={busy} />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={() => onRemove(id)}
                      aria-label={`Stop watching ${routeLabel(route)} in ${formatFlightMonth(route.month)}`}
                    >
                      Remove
                    </Button>
                  </div>
                  {/*
                  Always rendered, empty until there is something to say. An
                  empty paragraph with no margin lays out no line box and so
                  costs no height — and a live region has to be in the document
                  before its content changes if a screen reader is to announce
                  it, which a node that appears along with its own text is not.
                */}
                  <p
                    className={
                      report && !report.ok ? `${styles.report} ${styles.refused}` : styles.report
                    }
                    aria-live="polite"
                  >
                    {report?.text ?? ''}
                  </p>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
