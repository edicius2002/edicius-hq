import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SeacePage } from './SeacePage';
import { SeacePartialRestoreError, type SeacePageQuery, type SeaceRow } from './data';

const mocks = vi.hoisted(() => ({
  loadSeacePage: vi.fn(),
  loadSeaceSync: vi.fn(),
  setExcluded: vi.fn(),
  setExcludedMany: vi.fn(),
}));
vi.mock('./data', () => ({
  ...mocks,
  SeacePartialRestoreError: class SeacePartialRestoreError extends Error {
    constructor() {
      super('Some records may have been restored. Refreshing the table.');
    }
  },
  exclusionKey: (row: { payload: Record<string, unknown> }) =>
    `minor:${JSON.stringify([row.payload.region, row.payload.code])}`,
}));

let fixtureRows: SeaceRow[];
let excludedKeys: Set<string>;

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
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const result = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/seace/recent" element={<SeacePage />} />
          <Route path="/seace/all-open" element={<SeacePage />} />
          <Route path="/seace/closed" element={<SeacePage />} />
          <Route path="/seace/published" element={<SeacePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { ...result, client };
}

describe('SEACE views', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const now = Date.now();
    fixtureRows = [
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
    ];
    excludedKeys = new Set();
    mocks.loadSeacePage.mockImplementation(async (query: SeacePageQuery) => {
      const filtered = fixtureRows.filter((row) => {
        const payload = row.payload;
        const code = String(payload.code ?? '');
        if (query.view === 'published' ? row.kind !== 'contracts' : row.kind === 'contracts')
          return false;
        if (query.view === 'recent' && code === 'CM-OLDER') return false;
        if (query.view === 'open' && code !== 'CM-OLDER') return false;
        if (query.view === 'closed') return false;
        if (query.minorOnly && !payload.minor) return false;
        if (
          query.objectFilter !== 'Todos' &&
          !String(payload.object ?? '').startsWith(query.objectFilter)
        )
          return false;
        if (
          excludedKeys.has(`minor:${JSON.stringify([payload.region, payload.code])}`) !==
          query.excluded
        )
          return false;
        if (
          query.search &&
          !['code', 'entity', 'description', 'contractor', 'object'].some((field) =>
            String(payload[field] ?? '')
              .toLowerCase()
              .includes(query.search.toLowerCase()),
          )
        )
          return false;
        return true;
      });
      return {
        total: filtered.length,
        rows: filtered.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      };
    });
    mocks.loadSeaceSync.mockResolvedValue([]);
    mocks.setExcluded.mockResolvedValue(undefined);
    mocks.setExcludedMany.mockImplementation(async (keys: string[], excluded: boolean) => {
      for (const key of keys) {
        if (excluded) excludedKeys.add(key);
        else excludedKeys.delete(key);
      }
    });
  });

  it('shows the record count in the compact toolbar', async () => {
    mount();
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByText('1 record')).toBeInTheDocument();
  });

  it.each([
    { path: '/seace/recent', view: 'recent' },
    { path: '/seace/all-open', view: 'open' },
    { path: '/seace/closed', view: 'closed' },
    { path: '/seace/published', view: 'published' },
  ] as const)('shows table placeholders during the first $view load', async ({ path, view }) => {
    let finishPage!: (value: { rows: SeaceRow[]; total: number }) => void;
    mocks.loadSeacePage.mockImplementation((query: SeacePageQuery) =>
      query.view === view && query.minorOnly && !query.excluded
        ? new Promise((resolve) => {
            finishPage = resolve;
          })
        : Promise.resolve({ rows: [], total: 0 }),
    );

    const { container } = mount(path);
    expect(screen.getByRole('status')).toHaveTextContent('Loading SEACE records');
    expect(container.querySelectorAll('[data-testid="seace-skeleton-row"]')).toHaveLength(10);
    expect(container.querySelector('table')).toHaveAttribute('aria-hidden', 'true');
    const headers = [...container.querySelectorAll('thead th')];
    const skeletonCells = [
      ...container.querySelectorAll('[data-testid="seace-skeleton-row"] td'),
    ].slice(0, headers.length);
    expect(skeletonCells.map((cell) => cell.className.includes('mobileHiddenColumn'))).toEqual(
      headers.map((header) => header.className.includes('mobileHiddenColumn')),
    );
    expect(screen.queryByText('0 records')).not.toBeInTheDocument();
    expect(
      screen.queryByText('No records match this view and these filters.'),
    ).not.toBeInTheDocument();

    await act(async () =>
      finishPage({
        rows: [
          {
            kind: view === 'published' ? 'contracts' : 'notices',
            recordKey: view,
            payload: { region: 'Arequipa', code: `CM-${view}` },
          },
        ],
        total: 1,
      }),
    );
    expect(await screen.findByText(`CM-${view}`)).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid="seace-skeleton-row"]')).toHaveLength(0);
    expect(container.querySelector('table')).not.toHaveAttribute('aria-hidden');
  });

  it('loads the next server page without fetching all matching records', async () => {
    const next = {
      ...fixtureRows[0],
      recordKey: 'PAGE-2',
      payload: { ...fixtureRows[0].payload, code: 'CM-PAGE-2' },
    };
    mocks.loadSeacePage.mockImplementation(async (query: SeacePageQuery) => ({
      total: 61,
      rows: query.page === 1 ? [fixtureRows[0]] : [next],
    }));

    mount();
    await screen.findByText('CM-RECENT');
    expect(screen.getByText('1–1 of 61')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('CM-PAGE-2')).toBeInTheDocument();
    expect(screen.getByText('51–51 of 61')).toBeInTheDocument();
    expect(mocks.loadSeacePage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        view: 'recent',
        page: 2,
        pageSize: 50,
      }),
    );
  });

  it('keeps the current page visible while an uncached next page loads', async () => {
    let finishNext!: (value: { rows: SeaceRow[]; total: number }) => void;
    mocks.loadSeacePage.mockImplementation((query: SeacePageQuery) =>
      query.page === 1
        ? Promise.resolve({ rows: [fixtureRows[0]], total: 61 })
        : new Promise((resolve) => {
            finishNext = resolve;
          }),
    );

    mount();
    await screen.findByText('CM-RECENT');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByText('61 records')).toBeInTheDocument();
    expect(screen.getByText('Loading…')).toBeInTheDocument();

    await act(async () => finishNext({ rows: [fixtureRows[1]], total: 61 }));
    expect(await screen.findByText('CM-OLDER')).toBeInTheDocument();
    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();
  });

  it('prefetches the next page and reuses visited pages without another request', async () => {
    mocks.loadSeacePage.mockImplementation(async (query: SeacePageQuery) => ({
      rows: [query.page === 1 ? fixtureRows[0] : fixtureRows[1]],
      total: 61,
    }));

    mount();
    await screen.findByText('CM-RECENT');
    await waitFor(() =>
      expect(mocks.loadSeacePage).toHaveBeenCalledWith(expect.objectContaining({ page: 2 })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    expect(screen.getByText('CM-OLDER')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Previous' }));
    expect(screen.getByText('CM-RECENT')).toBeInTheDocument();
    expect(
      mocks.loadSeacePage.mock.calls.filter(
        ([query]) => query.page === 1 && query.excluded === false && query.minorOnly === true,
      ),
    ).toHaveLength(1);
  });

  it('prefetches Excluded for the current filters so switching shows cached records', async () => {
    fixtureRows = [
      fixtureRows[0],
      {
        ...fixtureRows[0],
        recordKey: 'EXCLUDED',
        payload: { ...fixtureRows[0].payload, code: 'CM-EXCLUDED' },
      },
      fixtureRows[1],
    ];
    excludedKeys = new Set(['minor:["Arequipa","CM-EXCLUDED"]']);

    mount();
    await screen.findByText('CM-RECENT');
    await waitFor(() =>
      expect(
        mocks.loadSeacePage.mock.calls.some(
          ([query]) => query.excluded === true && query.page === 1,
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getByText('CM-EXCLUDED')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    expect(
      mocks.loadSeacePage.mock.calls.filter(
        ([query]) => query.excluded === true && query.minorOnly === true,
      ),
    ).toHaveLength(1);
  });

  it.each([
    { path: '/seace/recent', view: 'recent' },
    { path: '/seace/all-open', view: 'open' },
    { path: '/seace/closed', view: 'closed' },
    { path: '/seace/published', view: 'published' },
  ] as const)('prefetches Minor and exclusion states on $view', async ({ path, view }) => {
    const kind = view === 'published' ? 'contracts' : 'notices';
    fixtureRows = [
      {
        kind,
        recordKey: 'MINOR',
        payload: { region: 'Arequipa', code: 'CM-MINOR', minor: true },
      },
      {
        kind,
        recordKey: 'OTHER',
        payload: { region: 'Arequipa', code: 'CM-OTHER', minor: false },
      },
      {
        kind,
        recordKey: 'HIDDEN',
        payload: { region: 'Arequipa', code: 'CM-HIDDEN', minor: false },
      },
    ];
    excludedKeys = new Set(['minor:["Arequipa","CM-HIDDEN"]']);
    mocks.loadSeacePage.mockImplementation(async (query: SeacePageQuery) => {
      const rows = fixtureRows.filter(
        (row) =>
          (!query.minorOnly || row.payload.minor) &&
          excludedKeys.has(`minor:${JSON.stringify([row.payload.region, row.payload.code])}`) ===
            query.excluded,
      );
      return { rows, total: rows.length };
    });

    mount(path);
    await screen.findByText('CM-MINOR');
    await waitFor(() =>
      expect(
        [
          { minorOnly: true, excluded: true },
          { minorOnly: false, excluded: false },
          { minorOnly: false, excluded: true },
        ].every((variant) =>
          mocks.loadSeacePage.mock.calls.some(
            ([query]) =>
              query.view === view &&
              query.page === 1 &&
              query.minorOnly === variant.minorOnly &&
              query.excluded === variant.excluded,
          ),
        ),
      ).toBe(true),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Minor' }));
    expect(screen.getByText('CM-OTHER')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(screen.getByText('CM-HIDDEN')).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('ignores a stale recent response after switching to Open', async () => {
    let finishRecent!: (value: { rows: SeaceRow[]; total: number }) => void;
    mocks.loadSeacePage.mockImplementation((query: SeacePageQuery) =>
      query.view === 'recent'
        ? new Promise((resolve) => {
            finishRecent = resolve;
          })
        : Promise.resolve({ rows: [fixtureRows[1]], total: 1 }),
    );

    mount();
    await waitFor(() =>
      expect(mocks.loadSeacePage).toHaveBeenCalledWith(expect.objectContaining({ view: 'recent' })),
    );
    fireEvent.click(screen.getByRole('link', { name: 'Open' }));
    expect(await screen.findByText('CM-OLDER')).toBeInTheDocument();
    await act(async () => finishRecent({ rows: [fixtureRows[0]], total: 1 }));
    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();
    expect(screen.getByText('CM-OLDER')).toBeInTheDocument();
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
    const rows = fixtureRows;
    const source = 'https://prod6.seace.gob.pe/buscador-publico/contrataciones/104513';
    const pdf = 'https://prod6.seace.gob.pe/documents/requirement.pdf';
    fixtureRows = [
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
    ];

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
    fixtureRows = [
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
    ];

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
      expect(
        screen.queryByRole('button', { name: /^Amount/, hidden: true }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /^Status/, hidden: true }),
      ).not.toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole('link', { name: 'Publi' }));
    expect(screen.getByRole('button', { name: /^Amount/, hidden: true })).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /^Supplier/, hidden: true }),
    ).not.toBeInTheDocument();
  });

  it('opens Items from the first link in Links when an item has text', async () => {
    const rows = fixtureRows;
    fixtureRows = [
      { ...rows[0], payload: { ...rows[0].payload, items: ['Pump (2)', 'Valve (1)'] } },
    ];
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
    const rows = fixtureRows;
    fixtureRows = [
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
    ];
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
    const rows = fixtureRows;
    fixtureRows = [
      {
        ...rows[0],
        payload: {
          ...rows[0].payload,
          start: '23/10/2026 10:00:00',
          end: '27/10/2026 23:30:00',
        },
      },
    ];
    mount();
    await screen.findByText('CM-RECENT');
    const row = screen.getByText('CM-RECENT').closest('tr')!;
    const combined = row.cells[6];
    expect(within(combined).getByText('23/10 10:00')).toBeInTheDocument();
    expect(within(combined).getByText('27/10 23:30')).toBeInTheDocument();
  });

  it('uses Entity first when Published has no Items and combines its term dates', async () => {
    const rows = fixtureRows;
    fixtureRows = [
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
    ];
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
    const rows = fixtureRows;
    fixtureRows = [
      {
        ...rows[0],
        kind: 'contracts',
        payload: { ...rows[0].payload, code: 'CM-PUBLISHED', items: ['Contract item'] },
      },
    ];
    mount('/seace/published');
    expect(await screen.findByRole('button', { name: 'Items' })).toBeInTheDocument();
  });

  it('toggles only the clicked row from empty cell space without selecting its text', async () => {
    fixtureRows.push({
      ...fixtureRows[0],
      recordKey: '3',
      payload: { ...fixtureRows[0].payload, code: 'CM-SECOND' },
    });
    mount();
    const code = await screen.findByText('CM-RECENT');
    const firstRow = code.closest('tr')!;
    const firstCheckbox = within(firstRow).getByRole('checkbox', { name: 'Select CM-RECENT' });
    const secondCheckbox = screen.getByRole('checkbox', { name: 'Select CM-SECOND' });

    fireEvent.click(firstRow.cells[2]);
    expect(firstCheckbox).toBeChecked();
    expect(secondCheckbox).not.toBeChecked();

    fireEvent.click(code);
    expect(firstCheckbox).toBeChecked();

    fireEvent.click(firstRow.cells[0]);
    expect(firstCheckbox).not.toBeChecked();

    fireEvent.click(firstCheckbox);
    expect(firstCheckbox).toBeChecked();
  });

  it('keeps links and Items independent while empty space in Links toggles selection', async () => {
    fixtureRows = [
      {
        ...fixtureRows[0],
        payload: {
          ...fixtureRows[0].payload,
          items: ['Pump'],
          documentName: 'Requirement.pdf',
          documentUrl: 'https://prod6.seace.gob.pe/documents/requirement.pdf',
        },
      },
    ];
    mount();
    const row = (await screen.findByText('CM-RECENT')).closest('tr')!;
    const checkbox = within(row).getByRole('checkbox', { name: 'Select CM-RECENT' });
    const dialog = document.querySelector('dialog') as HTMLDialogElement;
    dialog.showModal = vi.fn();

    fireEvent.click(within(row).getByRole('button', { name: 'Items' }));
    expect(checkbox).not.toBeChecked();

    fireEvent.click(within(row).getByRole('link', { name: 'Requirement.pdf' }));
    expect(checkbox).not.toBeChecked();

    fireEvent.click(row.cells[row.cells.length - 1]);
    expect(checkbox).toBeChecked();
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
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
  });

  it('removes a selected record while the exclusion write is still pending', async () => {
    let finishWrite!: () => void;
    mocks.setExcludedMany.mockImplementation(
      (keys: string[]) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            keys.forEach((key) => excludedKeys.add(key));
            resolve();
          };
        }),
    );

    mount();
    await screen.findByText('CM-RECENT');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));

    await waitFor(() => expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument());
    expect(mocks.setExcludedMany).toHaveBeenCalledTimes(1);
    await act(async () => finishWrite());
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
  });

  it('keeps the current page number while its last row is pending exclusion', async () => {
    const originalLoad = mocks.loadSeacePage.getMockImplementation()! as (
      query: SeacePageQuery,
    ) => Promise<{ rows: SeaceRow[]; total: number }>;
    const key = 'minor:["Arequipa","CM-RECENT"]';
    mocks.loadSeacePage.mockImplementation((query: SeacePageQuery) => {
      if (query.view === 'recent' && query.minorOnly && !query.excluded) {
        const removed = excludedKeys.has(key);
        return Promise.resolve({
          total: removed ? 50 : 51,
          rows: query.page === 2 ? (removed ? [] : [fixtureRows[0]]) : [fixtureRows[1]],
        });
      }
      return originalLoad(query);
    });
    let finishWrite!: () => void;
    mocks.setExcludedMany.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            excludedKeys.add(key);
            resolve();
          };
        }),
    );

    mount();
    await screen.findByText('CM-OLDER');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('CM-RECENT');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));

    await waitFor(() => expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument());
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(screen.getByText('0 shown of 51')).toBeInTheDocument();
    await act(async () => finishWrite());
  });

  it('restores the row and selection when an exclusion write fails', async () => {
    let failWrite!: () => void;
    mocks.setExcludedMany.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          failWrite = () => reject(new Error('Write refused'));
        }),
    );

    mount();
    await screen.findByText('CM-RECENT');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));
    await waitFor(() => expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument());

    await act(async () => failWrite());
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select CM-RECENT' })).toBeChecked();
    expect(screen.getByRole('status')).toHaveTextContent('Write refused');
  });

  it('refetches server state without reselecting after a partial restore', async () => {
    const key = 'minor:["Arequipa","CM-RECENT"]';
    excludedKeys.add(key);
    let failWrite!: () => void;
    mocks.setExcludedMany.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          failWrite = () => {
            excludedKeys.delete(key);
            reject(new SeacePartialRestoreError());
          };
        }),
    );

    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    await screen.findByText('CM-RECENT');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected (1)' }));
    await waitFor(() => expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument());

    await act(async () => failWrite());
    await waitFor(() => expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Restore selected (0)' })).toBeDisabled();
    expect(screen.getByRole('status')).toHaveTextContent('Some records');
  });

  it('keeps an optimistically removed row hidden when an older page read resolves', async () => {
    const originalLoad = mocks.loadSeacePage.getMockImplementation()! as (
      query: SeacePageQuery,
    ) => Promise<{ rows: SeaceRow[]; total: number }>;
    let finishRead!: () => void;
    let finishWrite!: () => void;
    let holdRead = false;
    mocks.loadSeacePage.mockImplementation((query: SeacePageQuery) =>
      holdRead && query.view === 'recent' && !query.excluded && query.minorOnly
        ? new Promise((resolve) => {
            finishRead = () => resolve({ rows: [fixtureRows[0]], total: 1 });
          })
        : originalLoad(query),
    );
    mocks.setExcludedMany.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            excludedKeys.add('minor:["Arequipa","CM-RECENT"]');
            holdRead = false;
            resolve();
          };
        }),
    );

    const { client } = mount();
    await screen.findByText('CM-RECENT');
    holdRead = true;
    void client.invalidateQueries({ queryKey: ['seace', 'page'], refetchType: 'active' });
    await waitFor(() => expect(finishRead).toBeDefined());

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));
    await waitFor(() => expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument());
    await act(async () => finishRead());
    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();
    await act(async () => finishWrite());
  });

  it('does not reselect a failed write after switching exclusion views', async () => {
    let failWrite!: () => void;
    mocks.setExcludedMany.mockImplementation(
      () =>
        new Promise<void>((_resolve, reject) => {
          failWrite = () => reject(new Error('Write refused'));
        }),
    );

    mount();
    await screen.findByText('CM-RECENT');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    await act(async () => failWrite());

    expect(screen.getByRole('button', { name: 'Restore selected (0)' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Not excluded' }));
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Select CM-RECENT' })).not.toBeChecked();
  });

  it('does not prefetch stale exclusion views while a write is pending', async () => {
    let finishWrite!: () => void;
    const { client } = mount();
    await screen.findByText('CM-RECENT');
    await waitFor(() =>
      expect(mocks.loadSeacePage.mock.calls.some(([query]) => query.excluded)).toBe(true),
    );
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['seace', 'page'], refetchType: 'none' });
    });
    const callsBeforeWrite = mocks.loadSeacePage.mock.calls.length;
    mocks.setExcludedMany.mockImplementation(
      (keys: string[]) =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            keys.forEach((key) => excludedKeys.add(key));
            resolve();
          };
        }),
    );

    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));
    await waitFor(() => expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument());
    expect(mocks.loadSeacePage.mock.calls).toHaveLength(callsBeforeWrite);

    await act(async () => finishWrite());
  });

  it('lets the active page reload finish before prefetching other views', async () => {
    const originalLoad = mocks.loadSeacePage.getMockImplementation()! as (
      query: SeacePageQuery,
    ) => Promise<{ rows: SeaceRow[]; total: number }>;
    let finishReload!: () => void;
    let holdReload = false;
    mocks.loadSeacePage.mockImplementation((query: SeacePageQuery) =>
      holdReload && query.view === 'recent' && !query.excluded && query.minorOnly
        ? new Promise((resolve) => {
            finishReload = () => resolve({ rows: [], total: 0 });
          })
        : originalLoad(query),
    );
    mocks.setExcludedMany.mockImplementation(async (keys: string[]) => {
      keys.forEach((key) => excludedKeys.add(key));
      holdReload = true;
    });

    mount();
    await screen.findByText('CM-RECENT');
    await waitFor(() => expect(mocks.loadSeacePage).toHaveBeenCalledTimes(4));
    const callsBeforeWrite = mocks.loadSeacePage.mock.calls.length;
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Exclude selected (1)' }));
    await waitFor(() => expect(finishReload).toBeDefined());

    expect(mocks.loadSeacePage.mock.calls.slice(callsBeforeWrite)).toHaveLength(1);
    await act(async () => finishReload());
  });

  it('shows separate included and excluded views from saved exclusion keys', async () => {
    excludedKeys = new Set(['minor:["Arequipa","CM-RECENT"]']);
    mount();
    await waitFor(() => expect(mocks.loadSeacePage).toHaveBeenCalled());

    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Excluded' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('restores a saved exclusion and returns the record to Not excluded', async () => {
    const key = 'minor:["Arequipa","CM-RECENT"]';
    excludedKeys = new Set([key]);
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    await screen.findByText('CM-RECENT');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select CM-RECENT' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore selected (1)' }));

    await waitFor(() => expect(mocks.setExcludedMany).toHaveBeenCalledWith([key], false));
    await waitFor(() => expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Not excluded' }));
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
  });

  it('excludes selected rows together and moves them to the excluded view', async () => {
    const rows = fixtureRows;
    fixtureRows = [
      rows[0],
      { ...rows[0], recordKey: '3', payload: { ...rows[0].payload, id: '3', code: 'CM-SECOND' } },
    ];
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
    await waitFor(() => expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Excluded' }));
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
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
    const rows = fixtureRows;
    fixtureRows = [
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
    ];
    mount();
    await screen.findByText('CM-RECENT');

    fireEvent.change(screen.getByRole('combobox', { name: 'Object' }), {
      target: { value: 'Servicio' },
    });
    expect(await screen.findByText('CM-SERVICIO')).toBeInTheDocument();
    expect(screen.queryByText('CM-RECENT')).not.toBeInTheDocument();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search records' }), {
      target: { value: 'Entidad A' },
    });
    expect(screen.queryByText('CM-SERVICIO')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Reset filters' }));
    expect(await screen.findByText('CM-RECENT')).toBeInTheDocument();
    expect(screen.getByText('CM-SERVICIO')).toBeInTheDocument();
  });
});
