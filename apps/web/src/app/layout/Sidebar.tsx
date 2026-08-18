import { NavLink } from 'react-router-dom';

import { ApiStatus } from '@/app/layout/ApiStatus';

import styles from './Sidebar.module.css';

const navItems = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/finance', label: 'Finance' },
  { to: '/greenlight', label: 'Greenlight' },
  { to: '/investing', label: 'Investing' },
  { to: '/airfare', label: 'Airfare' },
] as const;

export function Sidebar() {
  return (
    <aside className={styles.sidebar} aria-label="Primary">
      <div className={styles.brand}>Edicius HQ</div>
      <nav>
        <ul className={styles.navList}>
          {navItems.map((item) => (
            <li key={item.to}>
              <NavLink
                to={item.to}
                className={({ isActive }) =>
                  isActive ? `${styles.navLink} ${styles.navLinkActive}` : styles.navLink
                }
              >
                {item.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <ApiStatus />
    </aside>
  );
}
