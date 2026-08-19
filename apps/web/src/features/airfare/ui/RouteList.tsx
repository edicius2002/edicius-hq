import {
  formatFlightDate,
  routeId,
  routeLabel,
  type FareRoute,
} from '@/features/airfare/data/fareRoutes';
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
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (route: FareRoute) => void;
  onMove: (from: string, to: string) => void;
};

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
  onSelect,
  onRemove,
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
            return (
              <li
                key={id}
                className={`${styles.item} ${dragging === id ? styles.dragging : ''}`}
                {...rowProps(id)}
              >
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
                    leave Lima together, and without this the reader has no way
                    to tell which line is the row they are looking at.
                  */}
                  <span
                    className={styles.swatch}
                    style={{ background: colours.get(id) ?? 'var(--color-muted)' }}
                    aria-hidden="true"
                  />
                  {/*
                    Split so the arrow can be smaller and quieter than the two
                    codes — it is punctuation, not information. Read aloud it
                    becomes the word, because "LIM right-arrow CUZ" is not how
                    anyone says a route.
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
                      Up for the way out, down for the way back. The arrows are
                      hidden from the accessibility tree and the words carried
                      beside them, because "up arrow 2026-10-17" is not what a
                      departure date sounds like.
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
                    A departed route keeps its history — that is the point of an
                    archive — but nothing more will be collected for it, and saying
                    so is cheaper than letting the reader wonder why its series
                    stopped.
                  */}
                  {departed ? <span className={styles.departed}>Departed</span> : null}
                </button>
                <Button
                  variant="ghost"
                  size="small"
                  onClick={() => onRemove(id)}
                  aria-label={`Stop watching ${routeLabel(route)} on ${route.flightDate}`}
                >
                  Remove
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
