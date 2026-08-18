import { useState } from 'react';

import { routeId, routeLabel, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { RouteEditor } from '@/features/airfare/ui/RouteEditor';
import { Button } from '@/shared/ui/Button';

import styles from './RouteList.module.css';

type RouteListProps = {
  routes: FareRoute[];
  selectedId: string | null;
  today: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
  onAdd: (route: FareRoute) => void;
};

/**
 * The watchlist, and the form that adds to it.
 *
 * One panel rather than two. Adding a route and reviewing the routes are the
 * same task a minute apart, and splitting them meant the form sat permanently
 * open below the list taking as much room as the list itself — a five-field
 * form is not something anyone needs in view while reading prices. It folds
 * away behind one control instead, and opens where the new route will appear.
 */
export function RouteList({
  routes,
  selectedId,
  today,
  onSelect,
  onRemove,
  onAdd,
}: RouteListProps) {
  const [adding, setAdding] = useState(false);

  return (
    <div className={styles.panel}>
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

      {adding ? (
        <div className={styles.adder}>
          <RouteEditor
            today={today}
            onAdd={(route) => {
              onAdd(route);
              setAdding(false);
            }}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <Button
          variant="secondary"
          size="small"
          className={styles.addButton}
          onClick={() => setAdding(true)}
        >
          + Watch another route
        </Button>
      )}
    </div>
  );
}
