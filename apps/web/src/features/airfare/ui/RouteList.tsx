import {
  formatFlightDate,
  routeId,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
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
   * needs both ends, both dates and the currency. The row is holding all of
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
 * origin and destination on one row because they are one decision, the dates
 * below because they are the next.
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

  return (
    <div className={styles.panel}>
      <RouteEditor today={today} onAdd={onAdd} />

      {routes.length === 0 ? (
        <p className={styles.empty}>No routes watched yet.</p>
      ) : (
        <ul className={styles.list}>
          {routes.map((route) => {
            const id = routeId(route);
            const departed = route.flightDate < today;
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
                        Up for the way out, down for the way back. The arrows
                        are hidden from the accessibility tree and the words
                        carried beside them, because "up arrow 2026-10-17" is
                        not what a departure date sounds like.
                      */}
                      <span className={styles.leg}>
                        <span className={styles.arrow} aria-hidden="true">
                          ↑
                        </span>
                        <span className={styles.sr}>departs</span>
                        {formatFlightDate(route.flightDate)}
                      </span>
                      {route.returnDate ? (
                        <span className={styles.leg}>
                          <span className={styles.arrow} aria-hidden="true">
                            ↓
                          </span>
                          <span className={styles.sr}>returns</span>
                          {formatFlightDate(route.returnDate)}
                        </span>
                      ) : null}
                    </span>
                    {/*
                      A departed route keeps its history — that is the point of
                      an archive — but nothing more will be collected for it,
                      and saying so is cheaper than letting the reader wonder
                      why its series stopped.
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
                          ? `Collecting ${routeLabel(route)} on ${route.flightDate}`
                          : `Collect ${routeLabel(route)} on ${route.flightDate} now`
                      }
                    >
                      <CollectMark busy={busy} />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="small"
                    onClick={() => onRemove(id)}
                    aria-label={`Stop watching ${routeLabel(route)} on ${route.flightDate}`}
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
      )}
    </div>
  );
}
