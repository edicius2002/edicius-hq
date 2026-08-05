import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';

import styles from '@/app/layout/ErrorView.module.css';
import { PageHeader } from '@/shared/ui/PageHeader';

export function RouteErrorPage() {
  const error = useRouteError();

  let message = 'An unexpected error occurred.';
  if (isRouteErrorResponse(error)) {
    message = error.statusText || message;
  } else if (error instanceof Error) {
    message = error.message;
  }

  return (
    <div className={styles.page} role="alert">
      <PageHeader title="Route error" subtitle={message} titleId="route-error-title" />
      <p className={`${styles.copy} ${styles.danger}`}>{message}</p>
      <div className={styles.actions}>
        <Link className={styles.linkButton} to="/dashboard">
          Back to Dashboard
        </Link>
      </div>
    </div>
  );
}
