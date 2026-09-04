import { type FormEvent, useState } from 'react';

import { CeremonyCancelled, deviceLabel, enrol, signIn } from '@/features/auth/ceremony';
import { ApiError } from '@/shared/api/http';
import { Button } from '@/shared/ui/Button';
import { Panel } from '@/shared/ui/Panel';

import styles from './LoginScreen.module.css';

type LoginScreenProps = {
  onSignedIn: () => void;
};

/**
 * What an unauthenticated visitor sees instead of the app.
 *
 * It says how to enrol as well as how to sign in, because the first person to
 * reach this screen on a new device has a passkey for nothing and no other way
 * to find out that the answer is a command on the PC. A login screen that only
 * offers a login is a dead end for exactly the case it is most likely to meet.
 */
export function LoginScreen({ onSignedIn }: LoginScreenProps) {
  const [enrolling, setEnrolling] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      onSignedIn();
    } catch (error) {
      setMessage(describe(error));
    } finally {
      setBusy(false);
    }
  }

  function onEnrol(event: FormEvent) {
    event.preventDefault();
    void run(() => enrol(code, deviceLabel()));
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
          onClick={() => void run(signIn)}
        >
          Sign in
        </Button>

        {enrolling ? (
          <form className={styles.enrol} onSubmit={onEnrol}>
            <label className={styles.label} htmlFor="enrolment-code">
              Enrolment code
            </label>
            <input
              id="enrolment-code"
              className={styles.input}
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              placeholder="K7M2-9QX4"
            />
            <Button type="submit" disabled={busy || !code.trim()}>
              Enrol this device
            </Button>
          </form>
        ) : (
          <Button variant="ghost" className={styles.action} onClick={() => setEnrolling(true)}>
            Enrol a new device
          </Button>
        )}

        {/*
          The instruction is here rather than behind the toggle because someone
          who has no passkey yet does not know that "enrol" is the word for
          what they need, and this is the only place they can be told.

          Two sources for the code now, and the easy one goes first: a device
          already signed in can issue one from its own menu, which is what the
          person reading this has whenever they are adding a second device
          rather than rebuilding from nothing. The command stays named because
          it is still the only way to a *first* passkey, and the visitor who
          has none is exactly the one who cannot be told to go and use the app.
        */}
        <p className={styles.hint}>
          No passkey yet? On a device that is already signed in, open the menu and choose{' '}
          <strong>Enrol a device</strong>. If this is the first one, run{' '}
          <code className={styles.code}>node scripts/api.mjs enroll</code> on the PC that runs the
          API instead. Either way the code is good for ten minutes.
        </p>

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
 * A cancelled ceremony is not an error state. It says so and stays put, which
 * is what a person who changed their mind about the prompt expects to happen.
 *
 * Every genuine refusal from the API is the same 401 with the same body, on
 * purpose, so this cannot say more than it does — telling a wrong code from an
 * expired one would mean the API had reported on which codes exist.
 */
function describe(error: unknown): string {
  if (error instanceof CeremonyCancelled) {
    return 'That was cancelled. Nothing has changed — try again when you are ready.';
  }
  if (error instanceof ApiError && error.status === 401) {
    return 'That did not work. Check the code, or ask the PC for a new one.';
  }
  if (error instanceof Error) return error.message;
  return 'Something went wrong. Try again.';
}
