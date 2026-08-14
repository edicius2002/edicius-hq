import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GreenlightMeta } from '@/features/greenlight/model/types';
import { ImportPanel } from '@/features/greenlight/ui/ImportPanel';

afterEach(cleanup);

const META: GreenlightMeta = {
  fileName: 'TimeRecords.csv',
  rowsRead: 23,
  daysGenerated: 17,
  replaceMode: 'all',
  updatedAt: '2026-08-14T12:00:00.000Z',
  statusTitle: 'Updated from CSV',
  statusDetail:
    'Replaced all data with 17 day(s) from 23 rows. Markers were kept.',
};

function csvFile(name = 'TimeRecords.csv') {
  return new File(['Date,Record Type,Amount\n2026-08-03,Deliverable,10\n'], name, {
    type: 'text/csv',
  });
}

function renderPanel(overrides: Partial<ComponentProps<typeof ImportPanel>> = {}) {
  const onImport = vi.fn();
  const onClear = vi.fn();
  const onReplaceModeChange = vi.fn();
  render(
    <ImportPanel
      replaceMode="all"
      onReplaceModeChange={onReplaceModeChange}
      replaceMonthLabel="August 2026"
      meta={META}
      isImporting={false}
      isClearing={false}
      hasData
      onImport={onImport}
      onClear={onClear}
      {...overrides}
    />,
  );
  return { onImport, onClear, onReplaceModeChange };
}

describe('ImportPanel', () => {
  it('shows the stored import status detail, not only the file name', () => {
    renderPanel();
    expect(screen.getByText('TimeRecords.csv')).toBeInTheDocument();
    expect(
      screen.getByText('Replaced all data with 17 day(s) from 23 rows. Markers were kept.'),
    ).toBeInTheDocument();
  });

  it('names the clock month on the current-month radio and says it is a replace', () => {
    renderPanel({ replaceMode: 'current-month' });
    expect(screen.getByLabelText('Replace August 2026 only')).toBeInTheDocument();
    expect(
      screen.getByText(/Replaces August 2026 entirely — days missing from the CSV are removed/),
    ).toBeInTheDocument();
  });

  it('exposes Select CSV as a labelled file input (keyboard-reachable)', () => {
    renderPanel();
    const input = screen.getByLabelText('Select CSV');
    expect(input).toHaveAttribute('type', 'file');
    expect(getComputedStyle(input).display).not.toBe('none');
  });

  it('asks before replacing everything, and does nothing until confirmed', async () => {
    const user = userEvent.setup();
    const { onImport } = renderPanel();

    await user.upload(screen.getByLabelText('Select CSV'), csvFile());
    expect(onImport).not.toHaveBeenCalled();

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('TimeRecords.csv');
    expect(alert).toHaveTextContent('Existing days not in the file will be lost');

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    expect(onImport).toHaveBeenCalledOnce();
    expect(onImport.mock.calls[0]?.[0]).toBeInstanceOf(File);
    expect(onImport.mock.calls[0]?.[0].name).toBe('TimeRecords.csv');
  });

  it('leaves data untouched when the replace-all confirm is cancelled', async () => {
    const user = userEvent.setup();
    const { onImport } = renderPanel();

    await user.upload(screen.getByLabelText('Select CSV'), csvFile());
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onImport).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('imports the current month without a confirm step', async () => {
    const user = userEvent.setup();
    const { onImport } = renderPanel({ replaceMode: 'current-month' });

    await user.upload(screen.getByLabelText('Select CSV'), csvFile());
    expect(onImport).toHaveBeenCalledOnce();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks before clearing, and does nothing until confirmed', async () => {
    const user = userEvent.setup();
    const { onClear } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).not.toHaveBeenCalled();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Clear all Greenlight data');

    await user.click(within(alert).getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('does not clear when the confirm is cancelled', async () => {
    const user = userEvent.setup();
    const { onClear } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onClear).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
