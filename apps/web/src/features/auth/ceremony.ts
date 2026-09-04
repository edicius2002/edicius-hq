import { apiRequest } from '@/shared/api/http';
import { writeToken } from '@/shared/auth/session';

/**
 * The two WebAuthn ceremonies, and the three requests either of them costs.
 *
 * The API sends and receives options and responses in WebAuthn's own JSON
 * dialect — base64url for every buffer — which is exactly what
 * `PublicKeyCredential.parseCreationOptionsFromJSON` and `.toJSON()` speak. So
 * there is no encoding step here and no second opinion about padding to keep
 * in step with py_webauthn's.
 */

type ChallengeResponse = {
  challengeId: string;
  options: Record<string, unknown>;
};

type TokenResponse = { token: string };

/**
 * The JSON statics, named locally because the DOM lib this project builds
 * against does not declare them yet. They are standard and shipped in every
 * browser this app targets; a browser without them cannot do WebAuthn at all,
 * which `assertSupported` says out loud rather than failing as `undefined is
 * not a function`.
 */
type CredentialJson = {
  parseCreationOptionsFromJSON(options: unknown): PublicKeyCredentialCreationOptions;
  parseRequestOptionsFromJSON(options: unknown): PublicKeyCredentialRequestOptions;
};

/** A ceremony the person dismissed. Not an error state to recover from. */
export class CeremonyCancelled extends Error {
  constructor() {
    super('The passkey prompt was dismissed.');
    this.name = 'CeremonyCancelled';
  }
}

function credentialJson(): CredentialJson {
  const statics = globalThis.PublicKeyCredential as unknown as CredentialJson | undefined;
  if (
    !statics ||
    typeof statics.parseCreationOptionsFromJSON !== 'function' ||
    typeof statics.parseRequestOptionsFromJSON !== 'function'
  ) {
    throw new Error('This browser does not support passkeys.');
  }
  return statics;
}

/**
 * A dismissed prompt and a refused one are the same two DOM exceptions, and
 * neither is a fault. `NotAllowedError` is what every browser raises when the
 * person closes the dialog; `AbortError` is what they raise when something
 * else cancels it first.
 */
function asCancellation(error: unknown): unknown {
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'AbortError')
  ) {
    return new CeremonyCancelled();
  }
  return error;
}

function toJSON(credential: Credential | null): unknown {
  const serialisable = credential as unknown as { toJSON?: () => unknown } | null;
  if (!serialisable || typeof serialisable.toJSON !== 'function') {
    throw new Error('The authenticator returned nothing usable.');
  }
  return serialisable.toJSON();
}

export type IssuedEnrolmentCode = {
  code: string;
  /**
   * A duration and not an instant, because the API and this browser are two
   * machines whose clocks need not agree — the phone reading this is often
   * reaching the API over Tailscale. Ten minutes from the moment the answer
   * arrives is true on both, where a server-side timestamp would have the page
   * call a live code dead, or the reverse.
   */
  expiresInSeconds: number;
};

/**
 * A code for the next device, asked for by this one.
 *
 * Needs a session, so it is only reachable from inside the app. The CLI on the
 * PC issues the same thing and remains the way to a *first* passkey; this is
 * the way to a second one without walking to the PC.
 */
export function issueEnrolmentCode(): Promise<IssuedEnrolmentCode> {
  return apiRequest<IssuedEnrolmentCode>('/api/auth/enrolment-code', { method: 'POST' });
}

/** `200` while the stored token is still worth holding; throws otherwise. */
export function fetchSessionStatus(signal?: AbortSignal): Promise<{ authenticated: boolean }> {
  return apiRequest<{ authenticated: boolean }>('/api/auth/session', { signal });
}

export async function signIn(): Promise<void> {
  const statics = credentialJson();
  const { challengeId, options } = await apiRequest<ChallengeResponse>('/api/auth/login/options', {
    method: 'POST',
    body: {},
  });

  let credential: Credential | null;
  try {
    credential = await navigator.credentials.get({
      publicKey: statics.parseRequestOptionsFromJSON(options),
    });
  } catch (error) {
    throw asCancellation(error);
  }

  const { token } = await apiRequest<TokenResponse>('/api/auth/login/verify', {
    method: 'POST',
    body: { challengeId, response: toJSON(credential) },
  });
  writeToken(token);
}

export async function enrol(code: string, label: string): Promise<void> {
  const statics = credentialJson();
  const { challengeId, options } = await apiRequest<ChallengeResponse>(
    '/api/auth/register/options',
    { method: 'POST', body: { code } },
  );

  let credential: Credential | null;
  try {
    credential = await navigator.credentials.create({
      publicKey: statics.parseCreationOptionsFromJSON(options),
    });
  } catch (error) {
    throw asCancellation(error);
  }

  /*
   * The session comes back from this call, so enrolling signs you in. Asking
   * for a second ceremony immediately after the first would be asking someone
   * to prove twice, in the same minute, on the same device, something they
   * have just proved.
   */
  const { token } = await apiRequest<TokenResponse>('/api/auth/register/verify', {
    method: 'POST',
    body: { challengeId, code, response: toJSON(credential), label },
  });
  writeToken(token);
}

/** What the enrolled passkey is called in `node scripts/api.mjs credentials`. */
export function deviceLabel(): string {
  const agent = navigator.userAgent ?? '';
  const platform = agent.includes('Windows')
    ? 'Windows'
    : agent.includes('Mac')
      ? 'Mac'
      : agent.includes('iPhone')
        ? 'iPhone'
        : agent.includes('Android')
          ? 'Android'
          : 'Device';
  return `${platform} passkey`;
}
