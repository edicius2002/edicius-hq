import { useState } from 'react';

import { issueEnrolmentCode } from '@/features/auth/ceremony';
import { ApiError } from '@/shared/api/http';
import { Button } from '@/shared/ui/Button';

import styles from './EnrolDevice.module.css';

type Issued = {
  code: string;
  goodUntil: Date;
};

/**
 * How the owner adds a second device without walking to the PC.
 *
 * It lives at the bottom of the top bar's menu because that menu is the only
 * surface this app has that is not a page: there is no account screen and no
 * settings screen, and inventing one for a single button would be a screen
 * whose whole content is this. The menu is also where a `Sign out` belongs
 * whenever one is added, which is the same kind of thing.
 *
 * Deliberately mounted only while the menu is open, so the code goes when the
 * menu does. Reopening issues a fresh one and the store kills the old one, so
 * the thing on screen is always the code that works — there is no state here
 * that can be read minutes later and quietly be wrong.
 */
export function EnrolDevice() {
  const [issued, setIssued] = useState<Issued | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function issue() {
    setBusy(true);
    setMessage(null);
    try {
      const { code, expiresInSeconds } = await issueEnrolmentCode();
      setIssued({ code, goodUntil: new Date(Date.now() + expiresInSeconds * 1000) });
    } catch (error) {
      /*
       * A failed ask clears the code on screen, even though the one before it
       * may well still be live — a refused or unreachable request issued
       * nothing, so the store kept the old one. The ambiguity is the reason:
       * `apiRequest` gives up at five seconds, and a request that arrived and
       * whose answer did not is indistinguishable from one that never landed.
       * In that case the store *has* replaced the code, and the one left on
       * screen would be dead. Showing nothing sends the owner to the button
       * again; showing a corpse sends them to the other device to type it.
       */
      setIssued(null);
      setMessage(describe(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.enrol}>
      {issued ? (
        <div className={styles.issued} role="status">
          <p className={styles.code}>{group(issued.code)}</p>
          <p className={styles.hint}>
            Good until {clockTime(issued.goodUntil)}. Open this site on the new device, choose
            “Enrol a new device”, and type this in.
          </p>
        </div>
      ) : null}

      <Button size="small" disabled={busy} onClick={() => void issue()}>
        {issued ? 'New code' : 'Enrol a device'}
      </Button>

      {message ? (
        <p className={styles.message} role="alert">
          {message}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Two groups of four, the same way `node scripts/api.mjs enroll` prints it and
 * the same way the login screen's field shows it. The separator is decoration
 * — `auth_store.normalise_code` drops it, along with case and spaces — so it
 * exists only to stop eight characters in a row from being miscounted while
 * they are read off one screen and typed into another.
 */
function group(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/**
 * A wall-clock time rather than a ticking countdown, and read off the same
 * clock the person reading it is standing next to. A number of minutes goes
 * stale the moment it is rendered; a time does not, which matters because
 * this component makes no attempt to re-render itself.
 */
function clockTime(moment: Date): string {
  return moment.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * A 401 here is the session ending mid-use, which is worth saying plainly:
 * `http.ts` has already dropped the token, so the next reload is a login
 * screen and nothing the person does in this menu will work until then.
 */
function describe(error: unknown): string {
  if (error instanceof ApiError && error.status === 401) {
    return 'Your session has ended. Reload the page and sign in again.';
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Try again.';
}
