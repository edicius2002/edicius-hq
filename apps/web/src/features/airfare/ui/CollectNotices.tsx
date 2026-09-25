import type { CSSProperties } from 'react';

import { NOTICE_LIFE_MS, type CollectNotice } from '@/features/airfare/lib/collectNotice';

import styles from './CollectNotices.module.css';

/** The single visual and accessible surface for manual-request outcomes. */
export function CollectNotices({ notices }: { notices: readonly CollectNotice[] }) {
  // Absent rather than empty when there is nothing to say. This box is fixed
  // over the page, and an empty one would sit on top of whatever is in that
  // corner for the rest of the session.
  if (notices.length === 0) return null;
  return (
    <div className={styles.stack} data-testid="collect-notices">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={notice.kind === 'error' ? `${styles.notice} ${styles.refused}` : styles.notice}
          role={notice.kind === 'error' ? 'alert' : 'status'}
          aria-atomic="true"
          /*
            The card's own lifetime, handed to the stylesheet rather than
            written twice. The hook takes the card out of the document on a
            timer and the fade is a CSS animation, and two independently
            written durations drift the moment either is tuned — leaving a card
            that blinks out at full opacity, or one that sits invisible in the
            corner holding a slot. One number, in `collectNotice`, read by both.
          */
          style={{ '--notice-life': `${NOTICE_LIFE_MS}ms` } as CSSProperties}
        >
          <p className={styles.title}>{notice.title}</p>
          <p className={styles.text}>{notice.text}</p>
          {notice.detail ? <p className={styles.missed}>{notice.detail}</p> : null}
        </div>
      ))}
    </div>
  );
}
