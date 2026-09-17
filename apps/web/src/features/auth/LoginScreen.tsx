import { useState } from 'react';

import { signInWithPasskey } from '@/shared/auth/supabaseAuth';
import { Button } from '@/shared/ui/Button';
import { Panel } from '@/shared/ui/Panel';

import styles from './LoginScreen.module.css';

/** What an anonymous visitor sees while Supabase has no browser session. */
export function LoginScreen() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function runSignIn() {
    setBusy(true);
    setMessage(null);
    try {
      await signInWithPasskey();
    } catch (error) {
      setMessage(describePasskeyError(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.screen}>
      <Panel className={styles.card}>
        <h1 className={styles.title}>Edicius HQ</h1>
        <p className={styles.lede}>This page is private. Sign in with your passkey to continue.</p>

        <Button
          variant="primary"
          className={styles.action}
          disabled={busy}
          onClick={() => void runSignIn()}
        >
          Sign in with passkey
        </Button>

        {message ? (
          <p className={styles.message} role="alert">
            {message}
          </p>
        ) : null}
      </Panel>
    </div>
  );
}

/**
 * Dismissing a platform prompt is an unchanged login state, not an error.
 */
function describePasskeyError(error: unknown): string | null {
  if (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'AbortError' || error.name === 'NotAllowedError')
  ) {
    return null;
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Try again.';
}
