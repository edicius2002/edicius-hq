import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { ApiStatus } from '@/app/layout/ApiStatus';

import styles from './TopNav.module.css';

const navItems = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/finance', label: 'Finance' },
  { to: '/greenlight', label: 'Greenlight' },
  { to: '/investing', label: 'Investing' },
  { to: '/airfare', label: 'Airfare' },
] as const;

export function TopNav() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const location = useLocation();
  const activeItem = navItems.find((item) => item.to === location.pathname);
  const topbarRef = useRef<HTMLElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!open) return;

    function onMouseDown(event: MouseEvent) {
      if (!topbarRef.current?.contains(event.target as Node)) setOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    }

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <header ref={topbarRef} className={styles.topbar}>
      <div className={styles.brandBlock}>
        <div className={styles.brand}>Edicius HQ</div>
        <ApiStatus />
      </div>
      {activeItem ? (
        <h1 id="page-title" className={styles.pageTitle}>
          {activeItem.label}
        </h1>
      ) : null}
      <button
        ref={triggerRef}
        className={styles.menuButton}
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((isOpen) => !isOpen)}
      >
        Menu
      </button>
      {open ? (
        <nav id={menuId} className={styles.menu} aria-label="Primary">
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
      ) : null}
    </header>
  );
}
