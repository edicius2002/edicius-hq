import { useEffect, useRef, useState } from 'react';

import { toastBus, type Toast } from '@/shared/ui/toastBus';

import styles from './ToastHost.module.css';

/** Long enough to be read, short enough not to pile up on a busy market. */
const DISMISS_MS = 5000;

/**
 * Where every toast the app pushes ends up. Mounted once, above the router
 * (`App.tsx`), so it survives navigating between pages.
 *
 * Each toast gets its own dismiss timer, scheduled once when it first
 * appears and tracked in a ref keyed by id — not a single effect over the
 * whole list, which would restart every remaining toast's countdown each
 * time an unrelated one was added or removed.
 */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const scheduled = useRef(new Set<string>());

  useEffect(() => toastBus.subscribe(setToasts), []);

  useEffect(() => {
    for (const toast of toasts) {
      if (scheduled.current.has(toast.id)) continue;
      scheduled.current.add(toast.id);
      setTimeout(() => {
        scheduled.current.delete(toast.id);
        toastBus.dismiss(toast.id);
      }, DISMISS_MS);
    }
  }, [toasts]);

  if (!toasts.length) return null;

  return (
    <div className={styles.host} role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`${styles.toast} ${styles[toast.tone]}`}>
          <span>{toast.message}</span>
          <button
            type="button"
            className={styles.close}
            aria-label="Dismiss"
            onClick={() => toastBus.dismiss(toast.id)}
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
