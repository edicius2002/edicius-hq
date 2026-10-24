import { Skeleton } from './Skeleton';
import styles from './RowsSkeleton.module.css';

export function RowsSkeleton({ label, rows = 4 }: { label: string; rows?: number }) {
  return (
    <div className={styles.list} role="status" aria-label={label}>
      <span className={styles.srOnly}>{label}…</span>
      {Array.from({ length: rows }, (_, index) => (
        <div className={styles.row} data-testid="skeleton-row" key={index}>
          <Skeleton width={index % 2 ? '52%' : '72%'} height={13} />
          <Skeleton width="22%" height={13} />
        </div>
      ))}
    </div>
  );
}
