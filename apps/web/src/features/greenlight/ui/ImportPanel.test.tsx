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
  replaceMode: 'all',
  updatedAt: '2026-08-14T12:00:00.000Z',
  statusTitle: 'Updated from CSV',
  statusDetail: 'Replaced all data with 17 day(s) from 23 rows. Markers were kept.',
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
  const onReplaceModeChange = vi.fn();
  const onParseError = vi.fn();
  render(
    <ImportPanel
      replaceMode="all"
      onReplaceModeChange={onReplaceModeChange}
      replaceMonthLabel="August 2026"
      monthKey="2026-08"
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
  return { onImport, onClear, onReplaceModeChange, onParseError };
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

  it('shows that 1 July would disappear before current-month replace writes', async () => {
    const user = userEvent.setup();
    const { onImport } = renderPanel({
      replaceMode: 'current-month',
      replaceMonthLabel: 'July 2026',
      monthKey: '2026-07',
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

  it('does not offer Replace when the CSV matches stored days', async () => {
    const user = userEvent.setup();
    const { onImport } = renderPanel({
      replaceMode: 'current-month',
      monthKey: '2026-07',
      replaceMonthLabel: 'July 2026',
      stats: {
        '2026-07-05': day(390),
        '2026-07-06': day(1408.42),
        '2026-07-21': day(2275.14),
        '2026-07-28': day(1113.4),
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
      replaceMode: 'current-month',
      monthKey: '2026-07',
      stats: JULY_STATS,
    });

    await user.upload(screen.getByLabelText('Select CSV'), csvFile(JULY_CSV_WITHOUT_FIRST));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onImport).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('recomputes the preview when the replace mode changes', async () => {
    const user = userEvent.setup();
    const onReplaceModeChange = vi.fn();
    const stats = { ...JULY_STATS, '2026-04-17': day(388) };
    const { rerender } = render(
      <ImportPanel
        replaceMode="all"
        onReplaceModeChange={onReplaceModeChange}
        replaceMonthLabel="July 2026"
        monthKey="2026-07"
        stats={stats}
        meta={META}
        isImporting={false}
        isClearing={false}
        hasData
        onImport={vi.fn()}
        onParseError={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    await user.upload(screen.getByLabelText('Select CSV'), csvFile(JULY_CSV_WITHOUT_FIRST));
    expect(await screen.findByRole('alert')).toHaveTextContent('17/04');

    rerender(
      <ImportPanel
        replaceMode="current-month"
        onReplaceModeChange={onReplaceModeChange}
        replaceMonthLabel="July 2026"
        monthKey="2026-07"
        stats={stats}
        meta={META}
        isImporting={false}
        isClearing={false}
        hasData
        onImport={vi.fn()}
        onParseError={vi.fn()}
        onClear={vi.fn()}
      />,
    );

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('01/07');
    expect(alert).not.toHaveTextContent('17/04');
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
