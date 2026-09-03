/**
 * The session token, in `localStorage`, behind three functions.
 *
 * `localStorage` rather than memory because the session is thirty sliding days
 * and a memory-only token contradicts that: every new tab would raise the
 * platform's passkey prompt, which is a worse experience than the login screen
 * this feature exists to avoid. The cost is the one named in the design — a
 * token readable by any script that gets to run on this origin — and it is
 * accepted knowingly rather than by omission.
 *
 * Every access is wrapped. A browser with site data blocked throws on the mere
 * act of touching `localStorage`, and an app that cannot render at all in that
 * browser is a worse failure than one that asks for a passkey more often than
 * it needs to.
 */

const TOKEN_KEY = 'edicius-hq.session-token';

export function readToken(): string | null {
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Signed in for this tab's lifetime and asked again next time, which is
    // the graceful end of this failure rather than a broken app.
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Nothing to do: if it cannot be removed it could not have been stored.
  }
}
