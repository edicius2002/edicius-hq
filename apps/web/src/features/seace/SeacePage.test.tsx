import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SeacePage } from './SeacePage';

const mocks = vi.hoisted(() => ({
  loadSeace: vi.fn(),
  loadSeaceSync: vi.fn(),
  loadExclusions: vi.fn(),
  setExcluded: vi.fn(),
  setExcludedMany: vi.fn(),
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
        <Route path="/seace/closed" element={<SeacePage />} />
        <Route path="/seace/published" element={<SeacePage />} />
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
    mocks.loadExclusions.mockResolvedValue(new Set());
    mocks.loadSeaceSync.mockResolvedValue([]);
    mocks.setExcluded.mockResolvedValue(undefined);
    mocks.setExcludedMany.mockResolvedValue(undefined);
  });

  it('shows the record count in the compact toolbar', async () => {
    mount();
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByText('1 record')).toBeInTheDocument();
  });

  it('shows the latest fetch additions and Peru time beside Region', async () => {
    mocks.loadSeaceSync.mockResolvedValue([
      { kind: 'notices', fetched_at: '2026-10-23T14:42:53Z', record_count: 40, new_count: 4 },
      { kind: 'processes', fetched_at: '2026-10-23T14:42:53Z', record_count: 5, new_count: 2 },
      { kind: 'contracts', fetched_at: '2026-10-22T14:42:53Z', record_count: 15, new_count: 10 },
    ]);

    mount();
    const indicator = screen.getByLabelText('Last SEACE fetch');
    await within(indicator).findByText('23/10 · 09:42');
    expect(within(indicator).getByText('6 new')).toBeInTheDocument();
    expect(within(indicator).getByText('23/10 · 09:42')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Refresh region' })).not.toBeInTheDocument();
  });

  it('does not invent a new-record count for an older fetch', async () => {
    mocks.loadSeaceSync.mockResolvedValue([
      { kind: 'notices', fetched_at: '2026-10-23T14:42:53Z', record_count: 40, new_count: null },
    ]);

    mount();
    const indicator = screen.getByLabelText('Last SEACE fetch');
    await within(indicator).findByText('23/10 · 09:42');
    expect(within(indicator).getByText('— new')).toBeInTheDocument();
    expect(within(indicator).getByText('23/10 · 09:42')).toBeInTheDocument();
  });

  it('keeps last 24h notices out of Open', async () => {
    mount();
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.queryByText('CM-OLDER')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('link', { name: 'Open' }));
    expect(await screen.findByText('CM-OLDER')).toBeInTheDocument();
    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();
  });

  it('shows Items first, then only direct PDFs for notices', async () => {
    const rows = await mocks.loadSeace();
    const source = 'https://prod6.seace.gob.pe/buscador-publico/contrataciones/104513';
    const pdf = 'https://prod6.seace.gob.pe/documents/requirement.pdf';
    mocks.loadSeace.mockResolvedValue([
      {
        ...rows[0],
        payload: {
          ...rows[0].payload,
          id: '104513',
          source,
          items: ['Pump'],
          documents: [
            { name: 'Requirement PDF', url: pdf },
            { name: 'Metadata', url: 'https://prod6.seace.gob.pe/documents/metadata.json' },
          ],
        },
      },
    ]);

    mount();
    expect(await screen.findByRole('link', { name: 'Requirement PDF' })).toHaveAttribute(
      'href',
      pdf,
    );
    expect(screen.getByRole('button', { name: 'Items' }).parentElement?.firstElementChild).toBe(
      screen.getByRole('button', { name: 'Items' }),
    );
    expect(screen.queryByRole('link', { name: 'Official record' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CM-RECENT' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Metadata' })).not.toBeInTheDocument();
    expect(screen.getByText('CM-RECENT')).toBeInTheDocument();
  });

  it('shows only direct PDFs for published contracts', async () => {
    const source = 'https://prod4.seace.gob.pe:9000/api/bus/contrato/idContrato/2431209';
    const pdf = 'https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/153221571';
    mocks.loadSeace.mockResolvedValue([
      {
        kind: 'contracts',
        recordKey: '2431209',
        payload: {
          id: '2431209',
          code: 'CM-CONTRACT',
          region: 'Arequipa',
          minor: true,
          source,
          documentName: 'Contract.pdf',
          documentUrl: pdf,
        },
      },
    ]);

    mount('/seace/published');
    expect(await screen.findByRole('link', { name: 'Contract.pdf' })).toHaveAttribute('href', pdf);
    expect(screen.queryByRole('link', { name: 'Official data (JSON)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'CM-CONTRACT' })).not.toBeInTheDocument();
    expect(screen.getByText('CM-CONTRACT')).toBeInTheDocument();
  });

  it('omits Amount and Status in notice views and Supplier in Published', async () => {
    mount();
    await screen.findByText('CM-RECENT');

    for (const view of ['24h', 'Open', 'Closed']) {
      fireEvent.click(screen.getByRole('link', { name: view }));
      expect(screen.queryByRole('button', { name: /^Amount/ })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Status/ })).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('link', { name: 'Publi' }));
    expect(screen.getByRole('button', { name: /^Amount/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Supplier/ })).not.toBeInTheDocument();
  });

  it('opens Items from the first link in Links when an item has text', async () => {
    const rows = await mocks.loadSeace();
    mocks.loadSeace.mockResolvedValue([
      { ...rows[0], payload: { ...rows[0].payload, items: ['Pump (2)', 'Valve (1)'] } },
    ]);
    mount();
    await screen.findByText('CM-RECENT');
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    dialog.close = vi.fn(() => {
      dialog.removeAttribute('open');
      dialog.dispatchEvent(new Event('close'));
    });

    const itemLink = screen.getByRole('button', { name: 'Items' });
    expect(itemLink.parentElement?.firstElementChild).toBe(itemLink);
    expect(screen.queryByRole('button', { name: /^Items ↕/ })).not.toBeInTheDocument();
    fireEvent.click(itemLink);

    const modal = screen.getByRole('dialog', { name: 'Items' });
    expect(within(modal).getByText('Pump (2)')).toBeInTheDocument();
    expect(within(modal).getByText('Valve (1)')).toBeInTheDocument();
    fireEvent.click(within(modal).getByRole('button', { name: 'Close items' }));
    expect(dialog).not.toHaveAttribute('open');
  });

  it('offers Entity after Items and before PDFs in the mobile links', async () => {
    const rows = await mocks.loadSeace();
    mocks.loadSeace.mockResolvedValue([
      {
        ...rows[0],
        payload: {
          ...rows[0].payload,
          entity: 'SERVICIO DE AGUA POTABLE Y ALCANTARILLADO DE AREQUIPA',
          items: ['Pump'],
          documentName: 'Requirement.pdf',
          documentUrl: 'https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/1',
        },
      },
    ]);
    mount();
    await screen.findByText('CM-RECENT');
    const row = screen.getByText('CM-RECENT').closest('tr')!;
    const items = within(row).getByRole('button', { name: 'Items' });
    const entity = within(row).getByRole('link', { name: 'Entity' });
    const pdf = within(row).getByRole('link', { name: 'Requirement.pdf' });
    expect(items.nextElementSibling).toBe(entity);
    expect(entity.nextElementSibling).toBe(pdf);

    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn(() => dialog.setAttribute('open', ''));
    fireEvent.click(entity);
    expect(
      within(dialog).getByText('SERVICIO DE AGUA POTABLE Y ALCANTARILLADO DE AREQUIPA'),
    ).toBeInTheDocument();
  });

  it('includes Start and End together in the mobile date cell', async () => {
    const rows = await mocks.loadSeace();
    mocks.loadSeace.mockResolvedValue([
      {
        ...rows[0],
        payload: {
          ...rows[0].payload,
          start: '23/10/2026 10:00:00',
          end: '27/10/2026 23:30:00',
        },
      },
    ]);
    mount();
    await screen.findByText('CM-RECENT');
    const row = screen.getByText('CM-RECENT').closest('tr')!;
    const combined = row.cells[6];
    expect(within(combined).getByText('23/10 10:00')).toBeInTheDocument();
    expect(within(combined).getByText('27/10 23:30')).toBeInTheDocument();
  });

  it('uses Entity first when Published has no Items and combines its term dates', async () => {
    const rows = await mocks.loadSeace();
    mocks.loadSeace.mockResolvedValue([
      {
        ...rows[0],
        kind: 'contracts',
        payload: {
          ...rows[0].payload,
          code: 'CM-PUBLISHED',
          entity: 'EMPRESA DE GENERACION ELECTRICA DE AREQUIPA S.A.',
          termStart: '23/10/2026',
          termEnd: '26/10/2026',
          documentName: 'Contract.pdf',
          documentUrl: 'https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/1',
        },
      },
    ]);
    mount('/seace/published');
    await screen.findByText('CM-PUBLISHED');
    const row = screen.getByText('CM-PUBLISHED').closest('tr')!;
    const entity = within(row).getByRole('link', { name: 'Entity' });
    expect(within(row).queryByRole('button', { name: 'Items' })).not.toBeInTheDocument();
    expect(entity.parentElement?.firstElementChild).toBe(entity);
    expect(within(row.cells[6]).getByText('23/10')).toBeInTheDocument();
    expect(within(row.cells[6]).getByText('26/10')).toBeInTheDocument();
  });

  it('also offers Items in Published when a contract has item text', async () => {
    const rows = await mocks.loadSeace();
    mocks.loadSeace.mockResolvedValue([
      {
        ...rows[0],
        kind: 'contracts',
        payload: { ...rows[0].payload, code: 'CM-PUBLISHED', items: ['Contract item'] },
      },
    ]);
    mount('/seace/published');
    expect(await screen.findByRole('button', { name: 'Items' })).toBeInTheDocument();
  });

  it('moves an excluded record into the same view’s excluded table', async () => {
    mount();
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));
    await waitFor(() =>
      expect(mocks.setExcludedMany).toHaveBeenCalledWith(['minor:["Arequipa","CM-RECENT"]'], true),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getByText('CM-RECENT')).toBeInTheDocument();
  });

  it('shows separate included and excluded views from saved exclusion keys', async () => {
    mocks.loadExclusions.mockResolvedValue(new Set(['minor:["Arequipa","CM-RECENT"]']));
    mount();
    await screen.findByRole('button', { name: 'Not excluded' });

    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Excluded' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('restores a saved exclusion and returns the record to Not excluded', async () => {
    const key = 'minor:["Arequipa","CM-RECENT"]';
    mocks.loadExclusions.mockResolvedValue(new Set([key]));
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Excluded' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected (1)' }));

    await waitFor(() => expect(mocks.setExcludedMany).toHaveBeenCalledWith([key], false));
    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Not excluded' }));
    expect(screen.getByText('CM-RECENT')).toBeInTheDocument();
  });

  it('excludes selected rows together and moves them to the excluded view', async () => {
    const rows = await mocks.loadSeace();
    mocks.loadSeace.mockResolvedValue([
      rows[0],
      { ...rows[0], recordKey: '3', payload: { ...rows[0].payload, id: '3', code: 'CM-SECOND' } },
    ]);
    mount();
    await screen.findByText('CM-RECENT');

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-SECOND' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (2)' }));

    await waitFor(() =>
      expect(mocks.setExcludedMany).toHaveBeenCalledWith(
        ['minor:["Arequipa","CM-RECENT"]', 'minor:["Arequipa","CM-SECOND"]'],
        true,
      ),
    );
    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByText('CM-SECOND')).toBeInTheDocument();
  });

  it('keeps the compact controls without file import, sort selector, or scroll hint', async () => {
    mount();
    await screen.findByText('CM-RECENT');
    expect(screen.getByRole('button', { name: 'Not excluded' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Excluded' })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search records' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '24h' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Publi' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Minor' })).toBeChecked();
    expect(screen.queryByRole('combobox', { name: 'Entity' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Items' })).not.toBeInTheDocument();
    expect(screen.queryByText('Filters')).not.toBeInTheDocument();
    expect(screen.queryByText('Search')).not.toBeInTheDocument();
    expect(screen.getByText('1 record')).toBeInTheDocument();
    expect(screen.queryByText('Published minor contracts')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Exclusion JSON file')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Sort' })).not.toBeInTheDocument();
    expect(screen.queryByText('Scroll horizontally to see all columns →')).not.toBeInTheDocument();
  });

  it('filters by object and entity search and can reset the filters', async () => {
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
    await screen.findByText('CM-RECENT');

    fireEvent.change(screen.getByRole('combobox', { name: 'Object' }), {
      target: { value: 'Servicio' },
    });
    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();
    expect(screen.getByText('CM-SERVICIO')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search records' }), {
      target: { value: 'Entidad A' },
    });
    expect(screen.queryByText('CM-SERVICIO')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(screen.getByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByText('CM-SERVICIO')).toBeInTheDocument();
  });
});
