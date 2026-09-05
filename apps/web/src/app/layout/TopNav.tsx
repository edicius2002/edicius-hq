import { useEffect, useId, useRef, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

import { ApiStatus } from '@/app/layout/ApiStatus';
import { useIsNarrow } from '@/app/layout/useIsNarrow';

import styles from './TopNav.module.css';

const navItems = [
  { to: '/dashboard', label: 'Dashboard' },
  { to: '/finance', label: 'Finance' },
  { to: '/greenlight', label: 'Greenlight' },
  { to: '/investing', label: 'Investing' },
  { to: '/airfare', label: 'Airfare' },
] as const;

/**
 * How far in from the left edge a touch may begin and still be an attempt to
 * open the drawer.
 *
 * Small on purpose. The two pages with a full-bleed interactive surface put it
 * at x=40 (the Finance canvas) and x=61 (the Airfare globe), and both carry
 * `touch-action: none` — so anything wider than that would arm inside them and
 * turn every horizontal drag on a diagram or a globe into a navigation.
 */
export const EDGE_ZONE = 20;

/**
 * How far a touch must travel before it counts as a swipe rather than a press.
 *
 * Below this a tap that wobbles would open the drawer, which on a page whose
 * left edge is a scroll region is worse than a drawer that needs a second try.
 */
export const SWIPE_THRESHOLD = 40;

/** A touch that might still become a swipe. */
type Gesture = {
  pointerId: number;
  x: number;
  y: number;
  /** Which way it has to travel: out of the edge to open, back to close. */
  intent: 'open' | 'close';
};

export function TopNav() {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const location = useLocation();
  const narrow = useIsNarrow();
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

  // Crossing the threshold with the panel open would otherwise leave the other
  // branch's control expanded against a menu that is no longer rendered.
  const [shownNarrow, setShownNarrow] = useState(narrow);
  if (shownNarrow !== narrow) {
    setShownNarrow(narrow);
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

    // The drawer has a scrim of its own to close it, and the scrim covers the
    // page — so the wide branch's press-outside rule is the only one that
    // needs the document, and applying it to the drawer would close it on the
    // press that opened it.
    if (!narrow) document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [narrow, open]);

  /*
   * The edge swipe. Bound to the window rather than to a strip of the page,
   * because the gesture has to be available over whatever the route happens to
   * have painted at the left edge — and a real element there would be one more
   * thing for the Finance canvas to fight with.
   *
   * A gesture is armed on touch-down and then has one chance to prove itself
   * horizontal: the first move that travels further vertically than
   * horizontally disarms it, which is what keeps the drawer out of the way of
   * a page being scrolled with a thumb near the edge.
   */
  useEffect(() => {
    if (!narrow) return;
    let gesture: Gesture | null = null;

    function onPointerDown(event: PointerEvent) {
      // Touch only. A mouse has the brand button, and a trackpad drag near the
      // edge is a selection far more often than it is a navigation.
      if (event.pointerType !== 'touch') return;
      if (!open && event.clientX > EDGE_ZONE) return;
      gesture = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        intent: open ? 'close' : 'open',
      };
    }

    function onPointerMove(event: PointerEvent) {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      const dx = event.clientX - gesture.x;
      const dy = event.clientY - gesture.y;

      if (Math.abs(dy) > Math.abs(dx)) {
        gesture = null;
        return;
      }

      const travelled = gesture.intent === 'open' ? dx : -dx;
      if (travelled < SWIPE_THRESHOLD) return;

      setOpen(gesture.intent === 'open');
      gesture = null;
    }

    function onPointerEnd() {
      gesture = null;
    }

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointerup', onPointerEnd);
    window.addEventListener('pointercancel', onPointerEnd);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerEnd);
      window.removeEventListener('pointercancel', onPointerEnd);
    };
  }, [narrow, open]);

  const links = (
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
  );

  const brand = narrow ? (
    <button
      ref={triggerRef}
      className={`${styles.brand} ${styles.brandButton}`}
      type="button"
      aria-expanded={open}
      aria-controls={menuId}
      onClick={() => setOpen((isOpen) => !isOpen)}
    >
      Edicius HQ
    </button>
  ) : (
    <div className={styles.brand}>Edicius HQ</div>
  );

  return (
    <header ref={topbarRef} className={styles.topbar}>
      <div className={styles.brandBlock}>
        {brand}
        <ApiStatus />
      </div>
      {activeItem ? (
        /*
         * Hidden from the narrow row, never from the tree: Dashboard, Finance
         * and Greenlight name their main section with
         * `aria-labelledby="page-title"`, so removing it would leave three
         * pages with no accessible name at exactly the width where a screen
         * reader is most likely to be what is reading them.
         */
        <h1
          id="page-title"
          className={narrow ? `${styles.pageTitle} ${styles.pageTitleHidden}` : styles.pageTitle}
        >
          {activeItem.label}
        </h1>
      ) : null}

      {narrow ? null : (
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
      )}

      {open ? (
        narrow ? (
          <>
            <div
              className={styles.scrim}
              data-testid="drawer-scrim"
              onClick={() => setOpen(false)}
            />
            <nav id={menuId} className={styles.drawer} aria-label="Primary">
              {links}
            </nav>
          </>
        ) : (
          <nav id={menuId} className={styles.menu} aria-label="Primary">
            {links}
          </nav>
        )
      ) : null}
    </header>
  );
}
