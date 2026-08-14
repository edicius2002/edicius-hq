import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBackup } from '@/features/finance/lib/backup';
import { createEmptyDocument } from '@/features/finance/lib/document';

import { BackupControls } from './BackupControls';

afterEach(cleanup);

const DOCUMENT = createEmptyDocument('d1');

function backupFile(name = 'finance-backup-2026-08-06.json'): File {
  const backup = createBackup(DOCUMENT, '2026-08-06T10:00:00.000Z');
  return new File([JSON.stringify(backup)], name, { type: 'application/json' });
}

type Restore = (text: string) => Promise<string | null>;

function acceptAnything() {
  return vi.fn<Restore>(async () => null);
}

function renderControls(onRestore = acceptAnything()) {
  render(<BackupControls document={DOCUMENT} onRestore={onRestore} />);
  return onRestore;
}

describe('export', () => {
  it('offers the file rather than downloading it silently on load', () => {
    renderControls();
    expect(screen.getByRole('button', { name: 'Export' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
  });
});

describe('import', () => {
  it('asks before replacing, and names the file that would do it', async () => {
    const user = userEvent.setup();
    renderControls();

    await user.upload(screen.getByLabelText('Backup file'), backupFile());

    const confirmation = await screen.findByRole('alert');
    expect(confirmation).toHaveTextContent('finance-backup-2026-08-06.json');
    expect(confirmation).toHaveTextContent('replaces every diagram');
  });

  it('restores nothing until the question is answered', async () => {
    const user = userEvent.setup();
    const onRestore = renderControls();

    await user.upload(screen.getByLabelText('Backup file'), backupFile());
    await screen.findByRole('button', { name: 'Replace' });
    expect(onRestore).not.toHaveBeenCalled();
  });

  it('hands over the file contents once confirmed', async () => {
    const user = userEvent.setup();
    const onRestore = renderControls();

    await user.upload(screen.getByLabelText('Backup file'), backupFile());
    await user.click(await screen.findByRole('button', { name: 'Replace' }));

    await waitFor(() => expect(onRestore).toHaveBeenCalledTimes(1));
    const [text] = onRestore.mock.calls[0];
    expect(JSON.parse(text).document.diagrams).toHaveLength(1);
  });

  it('changes nothing when cancelled, and comes back ready to try again', async () => {
    const user = userEvent.setup();
    const onRestore = renderControls();

    await user.upload(screen.getByLabelText('Backup file'), backupFile());
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    expect(onRestore).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
  });

  it('reports a refusal instead of pretending it worked', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn<Restore>(
      async () => 'That file is not a Finance backup. Nothing was changed.',
    );
    renderControls(onRestore);

    await user.upload(screen.getByLabelText('Backup file'), backupFile('shopping.json'));
    await user.click(await screen.findByRole('button', { name: 'Replace' }));

    expect(await screen.findByText(/not a Finance backup/)).toBeInTheDocument();
    // Back to the two buttons, so a second attempt does not need a reload.
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
  });

  it('recovers from a rejected restore instead of staying on Restoring', async () => {
    const user = userEvent.setup();
    const onRestore = vi.fn<Restore>(async () => {
      throw new Error('storage unavailable');
    });
    renderControls(onRestore);

    await user.upload(screen.getByLabelText('Backup file'), backupFile());
    await user.click(await screen.findByRole('button', { name: 'Replace' }));

    expect(await screen.findByText(/Could not save the restored backup/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeInTheDocument();
  });
});
