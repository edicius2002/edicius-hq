import { useEffect, useRef, useState } from 'react';

import { DEV_SIGNED_OUT_KEY } from '@/shared/auth/devSignedOut';
import { signInLocally, signInWithPasskey } from '@/shared/auth/supabaseAuth';
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

        {import.meta.env.DEV ? <LocalSignIn /> : null}

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
 * Localhost cannot use a passkey bound to the production origin, so development
 * signs in through the dev server on its own — agents included — unless this
 * tab was deliberately signed out. `import.meta.env.DEV` is `false` in
 * production builds, which drops this control.
 */
function LocalSignIn() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const attempted = useRef(false);

  async function run() {
    attempted.current = true;
    setBusy(true);
    setMessage(null);
    try {
      sessionStorage.removeItem(DEV_SIGNED_OUT_KEY);
    } catch {
      // Storage can be unavailable in a browser that blocks site data.
    }
    try {
      await signInLocally();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Something went wrong. Try again.');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (attempted.current) return;
    let signedOut = false;
    try {
      signedOut = sessionStorage.getItem(DEV_SIGNED_OUT_KEY) !== null;
    } catch {
      // Without storage, sign in as if this tab were new.
    }
    if (!signedOut) void run();
  }, []);

  return (
    <div className={styles.devSession}>
      <Button disabled={busy} onClick={() => void run()}>
        Sign in locally
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
