import { Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';

import { TopNav } from '@/app/layout/TopNav';
import { PageSkeleton } from '@/shared/ui/PageSkeleton';
import { pageSkeletonForPath } from '@/shared/ui/pageSkeletonForPath';

import styles from './AppShell.module.css';

export function AppShell() {
  const pathname = useLocation().pathname;
  const isSeace = pathname.startsWith('/seace');
  return (
    <div className={styles.shell}>
      <TopNav />
      <main className={`${styles.main} ${isSeace ? styles.fullBleed : ''}`}>
        <Suspense fallback={<PageSkeleton page={pageSkeletonForPath(pathname)} />}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
