import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SeacePage } from './SeacePage';

const mocks = vi.hoisted(() => ({
  loadSeace: vi.fn(),
  loadSeaceSync: vi.fn(),
  loadExclusions: vi.fn(),
  setExcluded: vi.fn(),
  setExcludedMany: vi.fn(),
  enqueueRefresh: vi.fn(),
  refreshStatus: vi.fn(),
}));
vi.mock('./data', () => ({
  ...mocks,
  exclusionKey: (row: { payload: Record<string, unknown> }) =>
    `minor:${JSON.stringify([row.payload.region, row.payload.code])}`,
}));

const peru = (date: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: 'America/Lima',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .format(date)
    .replace(',', '');

function mount(path = '/seace/recent') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/seace/recent" element={<SeacePage />} />
        <Route path="/seace/all-open" element={<SeacePage />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe('SEACE views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const now = Date.now();
    mocks.loadSeace.mockResolvedValue([
      {
        kind: 'notices',
        recordKey: '1',
        payload: {
          id: '1',
          region: 'Arequipa',
          code: 'CM-RECENT',
          minor: true,
          state: 'Vigente',
          published: peru(new Date(now - 3_600_000)),
          end: peru(new Date(now + 86_400_000)),
        },
      },
      {
        kind: 'notices',
        recordKey: '2',
        payload: {
          id: '2',
          region: 'Arequipa',
          code: 'CM-OLDER',
          minor: true,
          state: 'Vigente',
          published: peru(new Date(now - 172_800_000)),
          end: peru(new Date(now + 86_400_000)),
        },
      },
    ]);
    mocks.loadSeaceSync.mockResolvedValue([]);
    mocks.loadExclusions.mockResolvedValue(new Set());
    mocks.setExcluded.mockResolvedValue(undefined);
    mocks.setExcludedMany.mockResolvedValue(undefined);
  });

  it('shows the number of loaded records when the source checkpoint differs', async () => {
    mocks.loadSeaceSync.mockResolvedValue([
      { kind: 'notices', fetched_at: '2026-10-23T01:47:17Z', record_count: 1 },
    ]);
    mount();
    expect(await screen.findByRole('link', { name: 'CM-RECENT' })).toBeInTheDocument();
    expect(screen.getByText('2 records')).toBeInTheDocument();
  });

  it('keeps last 24h notices out of All open', async () => {
    mount();
    expect(await screen.findByRole('link', { name: 'CM-RECENT' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CM-OLDER' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'All open' }));
    expect(await screen.findByRole('link', { name: 'CM-OLDER' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CM-RECENT' })).not.toBeInTheDocument();
  });

  it('moves an excluded record into the same view’s excluded table', async () => {
    mount();
    expect(await screen.findByRole('link', { name: 'CM-RECENT' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));
    await waitFor(() =>
      expect(mocks.setExcludedMany).toHaveBeenCalledWith(['minor:["Arequipa","CM-RECENT"]'], true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getByRole('link', { name: 'CM-RECENT' })).toBeInTheDocument();
  });

  it('shows separate included and excluded views from saved exclusion keys', async () => {
    mocks.loadExclusions.mockResolvedValue(new Set(['minor:["Arequipa","CM-RECENT"]']));
    mount();
    await screen.findByRole('button', { name: 'Not excluded' });

    expect(screen.queryByRole('link', { name: 'CM-RECENT' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getByRole('link', { name: 'CM-RECENT' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Excluded' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('excludes selected rows together and moves them to the excluded view', async () => {
    const rows = await mocks.loadSeace();
    mocks.loadSeace.mockResolvedValue([
      rows[0],
      { ...rows[0], recordKey: '3', payload: { ...rows[0].payload, id: '3', code: 'CM-SECOND' } },
    ]);
    mount();
    await screen.findByRole('link', { name: 'CM-RECENT' });

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-SECOND' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (2)' }));

    await waitFor(() =>
      expect(mocks.setExcludedMany).toHaveBeenCalledWith(
        ['minor:["Arequipa","CM-RECENT"]', 'minor:["Arequipa","CM-SECOND"]'],
        true,
      ),
    );
    expect(screen.queryByRole('link', { name: 'CM-RECENT' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getByRole('link', { name: 'CM-RECENT' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CM-SECOND' })).toBeInTheDocument();
  });

  it('imports exclusion keys from a local JSON file into the saved list', async () => {
    mount();
    await screen.findByRole('link', { name: 'CM-RECENT' });
    const key = 'minor:["Arequipa","CM-RECENT"]';
    const file = new File([JSON.stringify([key])], '.seace-exclusions.json', {
      type: 'application/json',
    });
    fireEvent.change(screen.getByLabelText('Exclusion JSON file'), {
      target: { files: [file] },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Import 1 code' }));

    await waitFor(() => expect(mocks.setExcludedMany).toHaveBeenCalledWith([key], true));
    expect(screen.getByText('1 excluded code')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CM-RECENT' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getByRole('link', { name: 'CM-RECENT' })).toBeInTheDocument();
  });

  it('filters the current view by object and entity and can reset the filters', async () => {
    const rows = await mocks.loadSeace();
    mocks.loadSeace.mockResolvedValue([
      { ...rows[0], payload: { ...rows[0].payload, object: 'Bien', entity: 'Entidad A' } },
      {
        ...rows[0],
        recordKey: '3',
        payload: {
          ...rows[0].payload,
          id: '3',
          code: 'CM-SERVICIO',
          object: 'Servicio',
          entity: 'Entidad B',
        },
      },
    ]);
    mount();
    await screen.findByRole('link', { name: 'CM-RECENT' });

    fireEvent.change(screen.getByRole('combobox', { name: 'Object' }), {
      target: { value: 'Servicio' },
    });
    expect(screen.queryByRole('link', { name: 'CM-RECENT' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CM-SERVICIO' })).toBeInTheDocument();

    fireEvent.change(screen.getByRole('combobox', { name: 'Entity' }), {
      target: { value: 'Entidad A' },
    });
    expect(screen.queryByRole('link', { name: 'CM-SERVICIO' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByRole('link', { name: 'CM-RECENT' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'CM-SERVICIO' })).toBeInTheDocument();
  });
});
