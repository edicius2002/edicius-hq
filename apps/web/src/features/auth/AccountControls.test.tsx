import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  registerPasskey: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('@/shared/auth/supabaseAuth', () => auth);

import { AccountControls } from '@/features/auth/AccountControls';

beforeEach(() => {
  auth.registerPasskey.mockResolvedValue({
    id: 'pk-1',
    friendlyName: 'Windows Hello',
    createdAt: '2026-09-16T00:00:00Z',
    lastUsedAt: null,
  });
  auth.signOut.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('AccountControls', () => {
  it('registers a passkey and reports its friendly name', async () => {
    const user = userEvent.setup();
    render(<AccountControls />);

    await user.click(screen.getByRole('button', { name: 'Add passkey' }));

    expect(await screen.findByRole('status')).toHaveTextContent('Windows Hello');
    expect(auth.registerPasskey).toHaveBeenCalledExactlyOnceWith();
  });

  it('signs out through the Supabase adapter', async () => {
    const user = userEvent.setup();
    render(<AccountControls />);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(auth.signOut).toHaveBeenCalledExactlyOnceWith();
  });
});
