import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({
  fetchLatest: vi.fn(),
  fetchHistory: vi.fn(),
  subscribeFxObservations: vi.fn(() => () => {}),
}));
vi.mock('./data', () => data);
vi.mock('@/shared/auth/supabaseAuth', () => ({
  subscribeToAuth: (callback: (event: string, session: { user: { id: string } }) => void) => {
    callback('INITIAL_SESSION', { user: { id: 'owner' } });
    return () => {};
  },
}));
import { UsdPenGadget } from './UsdPenGadget';
it('keeps the desktop pane split independent of table max-content width', async () => {
  const { readFileSync } = await vi.importActual<{
    readFileSync: (path: string, encoding: string) => string;
  }>('node:fs');
  const css = readFileSync('src/features/dashboard/fx/UsdPenGadget.module.css', 'utf8');
  const bodyRule = css.match(/\.body\s*\{([^}]*)\}/)?.[1];
  expect(bodyRule).toMatch(/grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/);
  expect(bodyRule).not.toContain('max-content');
});
const now = Date.parse('2026-09-29T15:00:00Z');
const row = {
  owner_id: 'owner',
  source: 'kambista',
  buy: 3.71,
  sell: 3.73,
  observed_at: '2026-09-29T14:50:00Z',
  effective_at: '2026-09-29T14:50:00Z',
  context: {},
};
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UsdPenGadget now={new Date(now)} />
    </QueryClientProvider>,
  );
  return client;
}
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  data.fetchLatest.mockResolvedValue([row]);
  data.fetchHistory.mockResolvedValue({
    points: [row, { ...row, effective_at: '2026-09-29T14:55:00Z', buy: 3.715 }],
    aggregation: 'observations',
  });
});
it('shows prices, three columns, and keyboard point details', async () => {
  mount();
  expect(screen.queryByRole('button', { name: 'Refresh' })).not.toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Select Kambista' })).toBeVisible();
  await screen.findByText('3.710');
  expect(screen.getByText('3.730')).toBeVisible();
  expect(screen.getAllByText('Best')).toHaveLength(2);
  expect(within(screen.getByRole('table')).getAllByRole('columnheader')).toHaveLength(3);
  expect(screen.queryByRole('columnheader', { name: 'Age' })).not.toBeInTheDocument();
  expect(await screen.findByRole('region', { name: 'Kambista USD/PEN history' })).toBeVisible();
  expect(screen.queryByRole('link', { name: /Kambista/ })).not.toBeInTheDocument();
  const chart = await screen.findByRole('slider', { name: 'History point' });
  fireEvent.keyDown(chart, { key: 'Home' });
  expect(screen.getByTestId('point-detail')).toHaveTextContent('3.71');
  fireEvent.keyDown(chart, { key: 'ArrowRight' });
  expect(screen.getByTestId('point-detail')).toHaveTextContent('3.715');
});
it('switches sources and ranges without mislabeling cached history', async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByRole('slider');
  data.fetchHistory.mockImplementation(() => new Promise(() => {}));
  await user.click(screen.getByRole('button', { name: 'Select SBS reference' }));
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  expect(screen.getByText('Loading history…')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '1M' }));
  expect(JSON.parse(localStorage.getItem('edicius.fx.preferences')!)).toMatchObject({
    source: 'sbs',
    range: '1M',
    favorites: [],
  });
});
it('keeps source order despite saved favorites and names the selected chart', async () => {
  localStorage.setItem(
    'edicius.fx.preferences',
    JSON.stringify({ source: 'kambista', range: '7D', favorites: ['sbs'] }),
  );
  const user = userEvent.setup();
  mount();
  expect(
    within(screen.getByRole('table'))
      .getAllByRole('button', { name: /^Select / })
      .map((button) => button.getAttribute('aria-label')),
  ).toEqual([
    'Select Kambista',
    'Select Tu Cambista',
    'Select Securex',
    'Select Cambio Seguro',
    'Select DollarHouse',
    'Select Rextie',
    'Select TKambio',
    'Select BCRP interbank',
    'Select SBS reference',
  ]);
  expect(await screen.findByRole('region', { name: 'Kambista USD/PEN history' })).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Select SBS reference' }));
  expect(
    await screen.findByRole('region', { name: 'SBS reference USD/PEN history' }),
  ).toBeVisible();
  expect(screen.getByRole('button', { name: 'Select SBS reference' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  expect(
    screen.queryByRole('button', { name: /favorite|expand|collapse/i }),
  ).not.toBeInTheDocument();
  expect(JSON.parse(localStorage.getItem('edicius.fx.preferences')!)).toMatchObject({
    source: 'sbs',
    favorites: ['sbs'],
  });
});
it('distinguishes missing data and load failures; excludes stale quotes from ranking', async () => {
  data.fetchLatest.mockResolvedValue([{ ...row, observed_at: '2026-09-20T00:00:00Z' }]);
  data.fetchHistory.mockResolvedValue({ points: [], aggregation: 'daily' });
  mount();
  const staleRow = (await screen.findByText('Stale')).closest('tr')!;
  expect(staleRow).toHaveAttribute('data-stale', 'true');
  expect(within(staleRow).getByText('Stale')).toBeInTheDocument();
  expect(within(staleRow).getAllByRole('cell')).toHaveLength(3);
  expect(screen.queryByText('Best')).not.toBeInTheDocument();
  expect(screen.queryByText('No capture')).not.toBeInTheDocument();
  for (const sourceRow of within(screen.getByRole('table')).getAllByRole('row').slice(2)) {
    expect(within(sourceRow).getAllByText('—')).toHaveLength(2);
  }
  expect(await screen.findByText(/No history for this range/)).toBeVisible();
});
it('retains same-source data on refresh failure and provides retry', async () => {
  const client = mount();
  await screen.findByRole('slider');
  data.fetchHistory.mockRejectedValue(new Error('offline'));
  await client.invalidateQueries({ queryKey: ['fx', 'owner', 'history'] });
  expect(await screen.findByText(/Could not refresh history/)).toBeVisible();
  expect(screen.getByRole('slider')).toBeVisible();
});
it('shows initial loading and then a useful error without fake prices', async () => {
  data.fetchLatest.mockRejectedValue(new Error('offline'));
  data.fetchHistory.mockRejectedValue(new Error('offline'));
  mount();
  expect(screen.getByText('Loading quotes…')).toBeVisible();
  await waitFor(() => expect(screen.getByText('Could not load quotes.')).toBeVisible());
  expect(screen.getByText('Could not load history.')).toBeVisible();
  expect(within(screen.getByRole('table')).queryByText('3.710')).not.toBeInTheDocument();
});
it('stays minimal: every source in one list, no category toggle or explanatory copy', async () => {
  mount();
  await screen.findByText('3.710');
  expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(10);
  expect(screen.queryByRole('navigation', { name: 'Source category' })).not.toBeInTheDocument();
  for (const name of ['Online', 'References']) {
    expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  }
  for (const copy of [
    /source buys your USD/,
    /Commercial history starts/,
    /Best = fresh/,
    /Missing periods/,
    /CURRENCY WATCH/,
    /SOURCE HISTORY/,
  ]) {
    expect(screen.queryByText(copy)).not.toBeInTheDocument();
  }
  expect(screen.queryByText('Fresh')).not.toBeInTheDocument();
});
