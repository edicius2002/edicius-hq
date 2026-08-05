import { Suspense } from 'react';
import { Outlet } from 'react-router-dom';

import { Sidebar } from '@/app/layout/Sidebar';

import styles from './AppShell.module.css';

export function AppShell() {
  return (
    <div className={styles.shell}>
      <Sidebar />
      <main className={styles.main}>
        <Suspense fallback={<p className={styles.fallback}>Loading…</p>}>
          <Outlet />
        </Suspense>
      </main>
    </div>
  );
}
