import { useState } from 'react';

import { registerPasskey, signOut } from '@/shared/auth/supabaseAuth';
import { Button } from '@/shared/ui/Button';

import styles from './AccountControls.module.css';

function describePasskeyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Try again.';
}

/** The account actions available from either branch of the navigation menu. */
export function AccountControls() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function addPasskey() {
    setBusy(true);
    setMessage(null);
    setError(null);
    try {
      const passkey = await registerPasskey();
      setMessage(passkey.friendlyName ? `Added ${passkey.friendlyName}.` : 'Passkey added.');
    } catch (caught) {
      setError(describePasskeyError(caught));
    } finally {
      setBusy(false);
    }
  }

  async function runSignOut() {
    setBusy(true);
    setError(null);
    try {
      await signOut();
    } catch (caught) {
      setError(describePasskeyError(caught));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.controls}>
      <Button size="small" disabled={busy} onClick={() => void addPasskey()}>
        Add passkey
      </Button>
      <Button size="small" variant="ghost" disabled={busy} onClick={() => void runSignOut()}>
        Sign out
      </Button>
      {message ? (
        <p className={styles.message} role="status">
          {message}
        </p>
      ) : null}
      {error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
