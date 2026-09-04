import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LoginScreen } from '@/features/auth/LoginScreen';
import { clearToken, readToken } from '@/shared/auth/session';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  clearToken();
});

/**
 * `navigator.credentials` is stubbed and no real ceremony runs. There is no
 * authenticator in jsdom, and a test that reached for one would be testing the
 * platform rather than this screen.
 */
function stubWebAuthn(credential: unknown = { toJSON: () => ({ id: 'x' }) }) {
  vi.stubGlobal('PublicKeyCredential', {
    parseCreationOptionsFromJSON: (options: unknown) => options,
    parseRequestOptionsFromJSON: (options: unknown) => options,
  });
  const get = vi.fn(async () => credential);
  const create = vi.fn(async () => credential);
  // Named fields, not `{ ...navigator }`: `userAgent` and friends are
  // prototype getters and a spread drops every one of them.
  vi.stubGlobal('navigator', { userAgent: navigator.userAgent, credentials: { get, create } });
  return { get, create };
}

function stubApi(handler: (url: string, init?: RequestInit) => Response) {
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    handler(String(input), init),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

const HAPPY_PATH = (url: string) => {
  if (url.includes('/options')) {
    return Response.json({ challengeId: 'c1', options: { challenge: 'abc' } });
  }
  if (url.includes('/verify')) return Response.json({ token: 'a-new-token' });
  return Response.json({ status: 'ok' });
};

beforeEach(() => {
  stubWebAuthn();
});

describe('LoginScreen', () => {
  it('offers a way in and a way to enrol', () => {
    render(<LoginScreen onSignedIn={() => {}} />);

    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /enrol a new device/i })).toBeInTheDocument();
  });

  it('tells a first-time visitor where the code comes from', () => {
    render(<LoginScreen onSignedIn={() => {}} />);

    // Two sources, and the screen has to name both. A device already signed in
    // can issue a code from its own menu, which is the ordinary case; the
    // command on the PC is the only route to a *first* passkey, and someone
    // holding none cannot be sent to an app they cannot open.
    expect(screen.getByText(/open the menu and choose/i)).toBeInTheDocument();
    expect(screen.getByText(/node scripts\/api\.mjs enroll/)).toBeInTheDocument();
  });

  it('shows the enrolment field when asked', async () => {
    const user = userEvent.setup();
    render(<LoginScreen onSignedIn={() => {}} />);

    expect(screen.queryByLabelText(/enrolment code/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /enrol a new device/i }));

    expect(screen.getByLabelText(/enrolment code/i)).toBeInTheDocument();
  });

  it('stores the token and reports success after signing in', async () => {
    const user = userEvent.setup();
    stubApi(HAPPY_PATH);
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(readToken()).toBe('a-new-token');
  });

  it('enrols with a code and is signed in by the same request', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubApi(HAPPY_PATH);
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    await user.click(screen.getByRole('button', { name: /enrol a new device/i }));
    await user.type(screen.getByLabelText(/enrolment code/i), 'K7M29QX4');
    await user.click(screen.getByRole('button', { name: /enrol this device/i }));

    await waitFor(() => expect(onSignedIn).toHaveBeenCalled());
    expect(readToken()).toBe('a-new-token');

    const sentCode = fetchSpy.mock.calls
      .map(([, init]) => String(init?.body ?? ''))
      .find((body) => body.includes('K7M29QX4'));
    expect(sentCode).toBeDefined();
  });

  it('says a cancelled ceremony changed nothing, and stays put', async () => {
    const user = userEvent.setup();
    stubApi(HAPPY_PATH);
    vi.stubGlobal('navigator', {
      userAgent: navigator.userAgent,
      credentials: {
        get: vi.fn(async () => {
          throw new DOMException('dismissed', 'NotAllowedError');
        }),
        create: vi.fn(),
      },
    });
    const onSignedIn = vi.fn();
    render(<LoginScreen onSignedIn={onSignedIn} />);

    await user.click(screen.getByRole('button', { name: /sign in/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/cancelled/i);
    expect(onSignedIn).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('reports a refused code without claiming to know why', async () => {
    const user = userEvent.setup();
    stubApi(() => Response.json({ detail: 'Authentication failed' }, { status: 401 }));
    render(<LoginScreen onSignedIn={() => {}} />);

    await user.click(screen.getByRole('button', { name: /enrol a new device/i }));
    await user.type(screen.getByLabelText(/enrolment code/i), 'BADCODE1');
    await user.click(screen.getByRole('button', { name: /enrol this device/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/did not work/i);
    expect(readToken()).toBeNull();
  });
});
