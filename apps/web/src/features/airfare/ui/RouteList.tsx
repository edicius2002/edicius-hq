import { routeId, routeLabel, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { RouteEditor } from '@/features/airfare/ui/RouteEditor';
import type { Airport } from '@/shared/api/fares';
import { Button } from '@/shared/ui/Button';

import styles from './RouteList.module.css';

type RouteListProps = {
  routes: FareRoute[];
  selectedId: string | null;
  today: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (route: FareRoute) => void;
  /** Airports already collected, offered as suggestions in the fields. */
  airports?: Airport[];
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
  selectedId,
  today,
  onSelect,
  onRemove,
  onAdd,
  airports = [],
}: RouteListProps) {
  return (
    <div className={styles.panel}>
      <RouteEditor today={today} onAdd={onAdd} airports={airports} />

      {routes.length === 0 ? (
        <p className={styles.empty}>No routes watched yet.</p>
      ) : (
        <ul className={styles.list}>
          {routes.map((route) => {
            const id = routeId(route);
            const departed = route.flightDate < today;
            return (
              <li key={id} className={styles.item}>
                <button
                  type="button"
                  className={
                    id === selectedId ? `${styles.route} ${styles.selected}` : styles.route
                  }
                  aria-current={id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(id)}
                >
                  <span className={styles.pair}>{routeLabel(route)}</span>
                  <span className={styles.dates}>
                    {route.flightDate}
                    {route.returnDate ? ` → ${route.returnDate}` : ''}
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
