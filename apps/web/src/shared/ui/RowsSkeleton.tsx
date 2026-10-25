import { Skeleton } from './Skeleton';
import styles from './RowsSkeleton.module.css';

export type RowsSkeletonVariant = 'watchlist' | 'positions' | 'alerts';

export function RowsSkeleton({
  label,
  rows = 4,
  variant,
}: {
  label?: string;
  rows?: number;
  variant: RowsSkeletonVariant;
}) {
  return (
    <div
      className={`${styles.list} ${styles[variant]}`}
      role={label ? 'status' : undefined}
      aria-label={label}
      data-skeleton-shape={variant}
    >
      {label ? <span className={styles.srOnly}>{label}…</span> : null}
      {Array.from({ length: rows }, (_, index) => (
        <div
          className={styles.row}
          data-testid="skeleton-row"
          data-skeleton-card={variant === 'positions' ? '' : undefined}
          key={index}
        >
          {variant === 'watchlist' ? (
            <>
              <div className={styles.identity} data-skeleton-cell>
                <Skeleton width={24} height={24} radius="50%" />
                <Skeleton width={index % 2 ? '45%' : '65%'} height={12} />
              </div>
              <div data-skeleton-cell>
                <Skeleton width="90%" height={13} />
              </div>
              <div data-skeleton-cell>
                <Skeleton width="80%" height={12} />
              </div>
            </>
          ) : variant === 'positions' ? (
            <>
              <div data-skeleton-cell>
                <Skeleton width="48%" height={14} />
              </div>
              <div data-skeleton-cell>
                <Skeleton width="90%" height={11} />
              </div>
              <div data-skeleton-cell>
                <Skeleton width="66%" height={14} />
              </div>
              <div data-skeleton-cell>
                <Skeleton width="88%" height={11} />
              </div>
            </>
          ) : (
            <>
              <div className={styles.alertIdentity} data-skeleton-cell>
                <Skeleton width="50%" height={12} />
                <Skeleton width="72%" height={10} />
              </div>
              <div data-skeleton-cell>
                <Skeleton width="65%" height={13} />
              </div>
              <div data-skeleton-cell>
                <Skeleton width={34} height={18} radius={99} />
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
