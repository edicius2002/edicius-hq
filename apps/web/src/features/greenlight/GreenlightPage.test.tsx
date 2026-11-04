import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock('@/shared/storage/supabaseStorage', () => ({
  readRemoteDocument: storage.read,
  writeRemoteDocument: storage.write,
}));

import { GreenlightPage } from '@/features/greenlight/GreenlightPage';
import { sharedQueryWrapper } from '@/test/queryWrapper';

const document = {
  key: 'greenlight',
  payload: {
    stats: { '2026-07-06': { Deliverable: { amount: 200, details: [] }, currency: 'USD' } },
    markers: [],
    widgets: {},
    meta: null,
  },
  revision: 1,
  updatedAt: '',
};

afterEach(() => {
  cleanup();
  storage.read.mockReset();
  storage.write.mockReset();
});

it('shows loading, then a recoverable read error, then the stored weeks', async () => {
  let rejectRead!: (error: Error) => void;
  let greenlightReads = 0;
  storage.read.mockImplementation((key: string) => {
    if (key !== 'greenlight') return Promise.resolve(null);
    greenlightReads += 1;
    return greenlightReads === 1
      ? new Promise((_resolve, reject) => {
          rejectRead = reject;
        })
      : Promise.resolve(document);
  });

  render(<GreenlightPage />, { wrapper: sharedQueryWrapper() });
  expect(screen.getByRole('status', { name: 'Loading greenlight' })).toBeInTheDocument();
  expect(screen.getByLabelText('Select CSV')).toBeDisabled();
  expect(screen.getByText('No weeks to show.')).not.toBeVisible();

  await waitFor(() => expect(rejectRead).toBeTypeOf('function'));
  await act(async () => rejectRead(new Error('unavailable')));
  expect(await screen.findByRole('button', { name: 'Retry load' })).toBeInTheDocument();
  expect(screen.getByText('Greenlight data unavailable.')).toBeInTheDocument();
  expect(screen.queryByText('No weeks to show.')).toBeNull();
  expect(screen.getByLabelText('Select CSV')).toBeDisabled();

  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry load' }));
  expect((await screen.findAllByText('$200.00')).length).toBeGreaterThan(0);
  expect(screen.queryByRole('button', { name: 'Retry load' })).toBeNull();
  expect(screen.getByLabelText('Select CSV')).toBeEnabled();
  expect(greenlightReads).toBe(2);
  expect(storage.write).not.toHaveBeenCalled();
});

it('keeps cached weeks and controls available after a background refresh fails', async () => {
  let greenlightReads = 0;
  storage.read.mockImplementation((key: string) => {
    if (key !== 'greenlight') return Promise.resolve(null);
    greenlightReads += 1;
    return greenlightReads === 1 ? Promise.resolve(document) : Promise.reject(new Error('offline'));
  });
  const wrapper = sharedQueryWrapper();
  render(<GreenlightPage />, { wrapper });
  expect((await screen.findAllByText('$200.00')).length).toBeGreaterThan(0);

  await act(async () => {
    await wrapper.client.refetchQueries({ queryKey: ['storage', 'greenlight'] });
  });
  expect(await screen.findByRole('button', { name: 'Retry load' })).toBeInTheDocument();
  expect(screen.getAllByText('$200.00').length).toBeGreaterThan(0);
  expect(screen.getByLabelText('Select CSV')).toBeEnabled();
  expect(screen.queryByText('Greenlight data unavailable.')).toBeNull();
});
