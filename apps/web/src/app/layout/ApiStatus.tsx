import { useQuery } from '@tanstack/react-query';

import { fetchHealth } from '@/shared/api/health';

import styles from './ApiStatus.module.css';

export function ApiStatus() {
  const healthQuery = useQuery({
    queryKey: ['api', 'health'],
    queryFn: ({ signal }) => fetchHealth(signal),
    refetchInterval: 30_000,
  });

  const label = healthQuery.isSuccess ? 'API online' : healthQuery.isError ? 'API offline' : 'API…';

  const stateClass = healthQuery.isSuccess
    ? styles.online
    : healthQuery.isError
      ? styles.offline
      : styles.pending;

  return (
    <div className={`${styles.status} ${stateClass}`} role="status" aria-live="polite">
      <span className={styles.dot} aria-hidden="true" />
      <span>{label}</span>
    </div>
  );
}
