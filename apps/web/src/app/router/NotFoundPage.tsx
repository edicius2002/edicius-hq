import { Link } from 'react-router-dom';

import styles from '@/app/layout/ErrorView.module.css';

export function NotFoundPage() {
  return (
    <section className={styles.page} aria-labelledby="not-found-title">
      <h1 id="not-found-title" className={styles.title}>
        Page not found
      </h1>
      <p className={styles.copy}>The page you requested does not exist.</p>
      <div className={styles.actions}>
        <Link className={styles.linkButton} to="/dashboard">
          Back to Dashboard
        </Link>
      </div>
    </section>
  );
}
