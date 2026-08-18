import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ComponentProps } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DayStats, GreenlightMeta } from '@/features/greenlight/model/types';
import { ImportPanel } from '@/features/greenlight/ui/ImportPanel';

afterEach(cleanup);

const META: GreenlightMeta = {
  fileName: 'TimeRecords.csv',
  rowsRead: 23,
  daysGenerated: 17,
  replaceMode: 'weeks',
  updatedAt: '2026-08-14T12:00:00.000Z',
  statusTitle: 'Updated from CSV',
  statusDetail:
    'Rebuilt 12 week(s) from the CSV (17 day(s)). Other weeks were kept. Markers were kept.',
};

function day(amount: number): DayStats {
  return { Deliverable: { amount, details: [] }, currency: 'USD' };
}

const JULY_STATS: Record<string, DayStats> = {
  '2026-07-01': day(3882.5),
  '2026-07-05': day(390),
  '2026-07-06': day(1408.42),
  '2026-07-21': day(2275.14),
  '2026-07-28': day(1113.4),
};

function csvFile(body: string, name = 'TimeRecords.csv') {
  return new File([body], name, { type: 'text/csv' });
}

const JULY_CSV_WITHOUT_FIRST = [
  'Date,Record Type,Amount,Currency',
  '2026-07-05,Deliverable,390,USD',
  '2026-07-06,Deliverable,1408.42,USD',
  '2026-07-21,Deliverable,2275.14,USD',
  '2026-07-28,Deliverable,1113.40,USD',
].join('\n');

function renderPanel(overrides: Partial<ComponentProps<typeof ImportPanel>> = {}) {
  const onImport = vi.fn();
  const onClear = vi.fn();
  const onParseError = vi.fn();
  render(
    <ImportPanel
      stats={{}}
      meta={META}
      isImporting={false}
      isClearing={false}
      hasData
      onImport={onImport}
      onParseError={onParseError}
      onClear={onClear}
      {...overrides}
    />,
  );
  return { onImport, onClear, onParseError };
}

describe('ImportPanel', () => {
  it('shows the stored import status detail, not only the file name', () => {
    renderPanel();
    expect(screen.getByText('TimeRecords.csv')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Rebuilt 12 week(s) from the CSV (17 day(s)). Other weeks were kept. Markers were kept.',
      ),
    ).toBeInTheDocument();
  });

  it('offers Replace all only when there is nothing stored yet', () => {
    renderPanel({ hasData: false, stats: {}, meta: null });
    expect(screen.getByText('Replace all')).toBeInTheDocument();
    expect(screen.getByText(/this CSV becomes the whole document/i)).toBeInTheDocument();
  });

  it('does not offer Replace all once there are stored days', () => {
    renderPanel({ hasData: true, stats: JULY_STATS });
    expect(screen.queryByText('Replace all')).toBeNull();
    expect(screen.getByText(/Rebuilds every week the CSV mentions/)).toBeInTheDocument();
  });

  it('exposes Select CSV as a labelled file input (keyboard-reachable)', () => {
    renderPanel();
    const input = screen.getByLabelText('Select CSV');
    expect(input).toHaveAttribute('type', 'file');
    expect(getComputedStyle(input).display).not.toBe('none');
  });

  it('shows that 1 July would disappear before the week rebuild writes', async () => {
    const user = userEvent.setup();
    const { onImport } = renderPanel({
      hasData: true,
      stats: JULY_STATS,
    });

    await user.upload(screen.getByLabelText('Select CSV'), csvFile(JULY_CSV_WITHOUT_FIRST));
    expect(onImport).not.toHaveBeenCalled();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('1 day disappears (01/07, $3,882.50)');
    expect(alert).toHaveTextContent('Total $9,069.46 → $5,186.96 (-$3,882.50)');

    await user.click(screen.getByRole('button', { name: 'Replace' }));
    expect(onImport).toHaveBeenCalledOnce();
  });

  it('does not offer Replace when the CSV matches stored days of those weeks', async () => {
    const user = userEvent.setup();
    const { onImport } = renderPanel({
      hasData: true,
      stats: {
        '2026-07-05': day(390),
        '2026-07-06': day(1408.42),
        '2026-07-21': day(2275.14),
        '2026-07-28': day(1113.4),
        '2026-04-17': day(388),
      },
    });

    await user.upload(screen.getByLabelText('Select CSV'), csvFile(JULY_CSV_WITHOUT_FIRST));
    expect(await screen.findByRole('alert')).toHaveTextContent(/no changes/i);
    expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
    expect(onImport).not.toHaveBeenCalled();
  });

  it('leaves data untouched when the import confirm is cancelled', async () => {
    const user = userEvent.setup();
    const { onImport } = renderPanel({
      hasData: true,
      stats: JULY_STATS,
    });

    await user.upload(screen.getByLabelText('Select CSV'), csvFile(JULY_CSV_WITHOUT_FIRST));
    const alert = await screen.findByRole('alert');
    await user.click(within(alert).getByRole('button', { name: 'Cancel' }));

    expect(onImport).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('asks before clearing, and does nothing until confirmed', async () => {
    const user = userEvent.setup();
    const { onClear } = renderPanel();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).not.toHaveBeenCalled();
    const alert = await screen.findByRole('alert');
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
