import type { CSSProperties } from 'react';

import { NOTICE_LIFE_MS, type CollectNotice } from '@/features/airfare/lib/collectNotice';

import styles from './CollectNotices.module.css';

/**
 * What a press the reader made came back with, in the corner of the page.
 *
 * A press is minutes long — up to thirty-one departures paced seconds apart —
 * and the sentence it earns has until now existed only under the row that
 * started it. By the time it lands the reader has scrolled the watchlist,
 * opened a chart, or gone to another window, and a line two hundred pixels
 * below where they are looking is a line they never read. So the same sentence
 * arrives once where they are, and leaves on its own.
 *
 * **The row keeps the record.** Nothing is moved here: the line under the row
 * still says what happened and still waits to be superseded by the next press.
 * That is what makes a card safe to take away after ten seconds — it is a
 * notification, and a notification that is missed costs nothing because the
 * durable copy is a scroll away.
 *
 * **Drawn, and never read aloud.** This is the one accessibility decision the
 * card makes, and it is to add nothing to the accessibility tree. The row's own
 * `<p aria-live="polite">` is given this exact sentence in the same commit that
 * raises this card, so a `role="status"` here would announce every finished
 * pass twice — the fault the progress bars on both lists already avoid by
 * staying out of the tree with `aria-hidden`. There is nothing focusable inside
 * either, so nothing is stranded behind it: the card cannot be dismissed by
 * hand, only waited out, and the row is where a screen reader hears the news
 * anyway.
 */
export function CollectNotices({ notices }: { notices: readonly CollectNotice[] }) {
  // Absent rather than empty when there is nothing to say. This box is fixed
  // over the page, and an empty one would sit on top of whatever is in that
  // corner for the rest of the session.
  if (notices.length === 0) return null;
  return (
    <div className={styles.stack} data-testid="collect-notices" aria-hidden="true">
      {notices.map((notice) => (
        <div
          key={notice.id}
          className={notice.report.ok ? styles.notice : `${styles.notice} ${styles.refused}`}
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
          <p className={styles.text}>{notice.report.text}</p>
        </div>
      ))}
    </div>
  );
}
