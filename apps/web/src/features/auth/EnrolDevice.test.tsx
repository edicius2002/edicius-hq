import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { EnrolDevice } from '@/features/auth/EnrolDevice';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * Codes handed out in the order given. The API answers a duration and not an
 * instant — six hundred seconds is `auth_store.CODE_TTL` — so this does too,
 * which is the whole reason the component can be trusted about the clock.
 */
function stubCodes(...codes: string[]) {
  const queue = [...codes];
  // Typed rather than taking named arguments it would not read: the request is
  // the same whichever call it is, and `fetchSpy.mock.calls` still has to know
  // the shape so a test can assert on the URL and the method.
  const fetchSpy = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(
    async () => Response.json({ code: queue.shift(), expiresInSeconds: 600 }),
  );
  vi.stubGlobal('fetch', fetchSpy);
  return fetchSpy;
}

describe('EnrolDevice', () => {
  it('offers a code without having asked for one yet', () => {
    stubCodes('K7M29QX4');
    render(<EnrolDevice />);

    expect(screen.getByRole('button', { name: 'Enrol a device' })).toBeInTheDocument();
    // Nothing is issued on mount. Opening the menu to look at the links would
    // otherwise mint a secret and, with one live code at a time, kill the one
    // the owner is halfway through typing on the other device.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('asks the API for a code and shows it the way the CLI prints it', async () => {
    const user = userEvent.setup();
    const fetchSpy = stubCodes('K7M29QX4');
    render(<EnrolDevice />);

    await user.click(screen.getByRole('button', { name: 'Enrol a device' }));

    // The separator is presentation — `normalise_code` drops it — but eight
    // characters in a row are what a person miscounts, so it has to be there.
    expect(await screen.findByText('K7M2-9QX4')).toBeInTheDocument();

    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toContain('/api/auth/enrolment-code');
    expect(init?.method).toBe('POST');
  });

  it('says how long the code is good for, against the reader’s own clock', async () => {
    const user = userEvent.setup();
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-09-04T14:22:00'));
    stubCodes('K7M29QX4');
    render(<EnrolDevice />);

    await user.click(screen.getByRole('button', { name: 'Enrol a device' }));

    // Ten minutes on from the moment the answer arrived, formatted locally.
    // A wall-clock time and not a count of minutes: nothing re-renders this,
    // so a number would be wrong within a minute of being drawn.
    const expected = new Date('2026-09-04T14:32:00').toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    expect(await screen.findByText(new RegExp(`Good until ${expected}`))).toBeInTheDocument();

    vi.useRealTimers();
  });

  it('replaces the code on screen when a second one is asked for', async () => {
    const user = userEvent.setup();
    stubCodes('K7M29QX4', 'P4TN8WRC');
    render(<EnrolDevice />);

    await user.click(screen.getByRole('button', { name: 'Enrol a device' }));
    await screen.findByText('K7M2-9QX4');

    // The store kills the first one when it issues the second, so showing both
    // would be showing a code that no longer opens anything.
    await user.click(screen.getByRole('button', { name: 'New code' }));

    expect(await screen.findByText('P4TN-8WRC')).toBeInTheDocument();
    expect(screen.queryByText('K7M2-9QX4')).not.toBeInTheDocument();
  });

  it('reports a session that ended rather than showing a code it does not have', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'Not authenticated' }, { status: 401 })),
    );
    render(<EnrolDevice />);

    await user.click(screen.getByRole('button', { name: 'Enrol a device' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/session has ended/i);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    // Still the first-ask label: nothing was issued, so there is no code to
    // replace and the button must not claim otherwise.
    expect(screen.getByRole('button', { name: 'Enrol a device' })).toBeInTheDocument();
  });
});
