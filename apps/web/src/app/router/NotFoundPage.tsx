import { Link } from 'react-router-dom';

import styles from '@/app/layout/ErrorView.module.css';
import { PageHeader } from '@/shared/ui/PageHeader';

export function NotFoundPage() {
  return (
    <section className={styles.page} aria-labelledby="not-found-title">
      <PageHeader
        title="Page not found"
        subtitle="The page you requested does not exist."
        titleId="not-found-title"
      />
      <div className={styles.actions}>
        <Link className={styles.linkButton} to="/dashboard">
          Back to Dashboard
        </Link>
      </div>
    </section>
  );
}
