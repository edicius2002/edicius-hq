import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ signInWithPasskey: vi.fn() }));

vi.mock('@/shared/auth/supabaseAuth', () => auth);

import { LoginScreen } from '@/features/auth/LoginScreen';

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('LoginScreen', () => {
  it('offers only passkey sign-in and no enrolment-code route', () => {
    render(<LoginScreen />);

    expect(screen.getByRole('button', { name: 'Sign in with passkey' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /enrol/i })).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/enrolment code/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/node scripts\/api\.mjs/i)).not.toBeInTheDocument();
  });

  it('calls the passkey adapter from its primary action', async () => {
    const user = userEvent.setup();
    auth.signInWithPasskey.mockResolvedValue(undefined);
    render(<LoginScreen />);

    await user.click(screen.getByRole('button', { name: 'Sign in with passkey' }));

    await waitFor(() => expect(auth.signInWithPasskey).toHaveBeenCalledExactlyOnceWith());
  });

  it('keeps a cancelled passkey prompt on the login screen without an alert', async () => {
    const user = userEvent.setup();
    auth.signInWithPasskey.mockRejectedValue(
      new DOMException('The passkey prompt was dismissed.', 'NotAllowedError'),
    );
    render(<LoginScreen />);

    await user.click(screen.getByRole('button', { name: 'Sign in with passkey' }));

    await waitFor(() => expect(auth.signInWithPasskey).toHaveBeenCalledExactlyOnceWith());
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with passkey' })).toBeInTheDocument();
  });

  it('renders exactly one alert for a genuine passkey error', async () => {
    const user = userEvent.setup();
    auth.signInWithPasskey.mockRejectedValue(new Error('Authenticator is unavailable.'));
    render(<LoginScreen />);

    await user.click(screen.getByRole('button', { name: 'Sign in with passkey' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Authenticator is unavailable.');
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });
});
