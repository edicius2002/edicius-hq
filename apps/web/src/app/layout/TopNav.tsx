import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { ApiStatus } from '@/app/layout/ApiStatus';
import { EnrolDevice } from '@/features/auth/EnrolDevice';

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

  // Closes the menu on navigation. Adjusted during render, like the React docs'
  // "adjusting state when a prop changes" recipe, rather than in an effect, so
  // there is no extra render with the menu still open at the new route.
  const [shownPathname, setShownPathname] = useState(location.pathname);
  if (shownPathname !== location.pathname) {
    setShownPathname(location.pathname);
    setOpen(false);
  }

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
        /*
         * The `nav` landmark wraps the links and stops there, so the enrolment
         * block below is not announced as navigation — it goes nowhere. The
         * dropdown itself is a plain box, which is also what `aria-controls`
         * on the trigger has to name.
         */
        <div id={menuId} className={styles.menu}>
          <nav aria-label="Primary">
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
          {/* The app has no account or settings screen, and this is the only
              surface that is on every page. It sits under a rule because it is
              not a sixth place to go. */}
          <div className={styles.account}>
            <EnrolDevice />
          </div>
        </div>
      ) : null}
    </header>
  );
}
