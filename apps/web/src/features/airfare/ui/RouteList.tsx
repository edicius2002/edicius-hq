import { routeId, routeLabel, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { Button } from '@/shared/ui/Button';

import styles from './RouteList.module.css';

type RouteListProps = {
  routes: FareRoute[];
  selectedId: string | null;
  today: string;
  onSelect: (id: string) => void;
  onRemove: (id: string) => void;
};

export function RouteList({ routes, selectedId, today, onSelect, onRemove }: RouteListProps) {
  if (routes.length === 0) {
    return <p className={styles.empty}>No routes watched yet.</p>;
  }

  return (
    <ul className={styles.list}>
      {routes.map((route) => {
        const id = routeId(route);
        const departed = route.flightDate < today;
        return (
          <li key={id} className={styles.item}>
            <button
              type="button"
              className={id === selectedId ? `${styles.route} ${styles.selected}` : styles.route}
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
              onClick={() => onRemove(id)}
              aria-label={`Stop watching ${routeLabel(route)} on ${route.flightDate}`}
            >
              Remove
            </Button>
          </li>
        );
      })}
    </ul>
  );
}
