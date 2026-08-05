import { Outlet } from 'react-router-dom';

import { Sidebar } from '@/app/layout/Sidebar';

import styles from './AppShell.module.css';

export function AppShell() {
  return (
    <div className={styles.shell}>
      <Sidebar />
      <main className={styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
