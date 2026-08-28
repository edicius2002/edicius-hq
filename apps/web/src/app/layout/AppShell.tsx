import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';

import { TopNav } from '@/app/layout/TopNav';

import styles from './AppShell.module.css';

export function AppShell() {
  return (
    <div className={styles.shell}>
      <TopNav />
      <main className={styles.main}>
        <Suspense fallback={<p className={styles.fallback}>Loading…</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
