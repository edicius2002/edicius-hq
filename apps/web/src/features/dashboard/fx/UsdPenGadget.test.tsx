import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
const data = vi.hoisted(() => ({ fetchLatest: vi.fn(), fetchHistory: vi.fn() }));
vi.mock('./data', () => data);
vi.mock('@/shared/auth/supabaseAuth', () => ({
  subscribeToAuth: (callback: (event: string, session: { user: { id: string } }) => void) => {
    callback('INITIAL_SESSION', { user: { id: 'owner' } });
    return () => {};
  },
}));
import { UsdPenGadget } from './UsdPenGadget';
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
it('shows both prices, independent best markers, source links and keyboard point details', async () => {
  mount();
  expect(await screen.findByRole('button', { name: 'Select Kambista' })).toBeVisible();
  await screen.findByText('3.710');
  expect(screen.getByText('3.730')).toBeVisible();
  expect(screen.getAllByText('Best')).toHaveLength(2);
  const chart = await screen.findByRole('slider', { name: 'History point' });
  fireEvent.keyDown(chart, { key: 'Home' });
  expect(screen.getByTestId('point-detail')).toHaveTextContent('3.71');
  fireEvent.keyDown(chart, { key: 'ArrowRight' });
  expect(screen.getByTestId('point-detail')).toHaveTextContent('3.715');
});
it('switches sources/ranges without mislabeling cached history, persists favorites and expands', async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByRole('slider');
  await user.click(screen.getByRole('button', { name: 'Favorite SBS reference' }));
  await user.click(screen.getByRole('button', { name: 'References' }));
  data.fetchHistory.mockImplementation(() => new Promise(() => {}));
  await user.click(screen.getByRole('button', { name: 'Select SBS reference' }));
  expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  expect(screen.getByText('Loading history…')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '1M' }));
  expect(JSON.parse(localStorage.getItem('edicius.fx.preferences')!)).toMatchObject({
    source: 'sbs',
    range: '1M',
    favorites: ['sbs'],
  });
  await user.click(screen.getByRole('button', { name: 'Expand chart' }));
  expect(screen.getByRole('button', { name: 'Collapse chart' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
});
it('distinguishes missing data and load failures; excludes stale quotes from ranking', async () => {
  data.fetchLatest.mockResolvedValue([{ ...row, observed_at: '2026-09-20T00:00:00Z' }]);
  data.fetchHistory.mockResolvedValue({ points: [], aggregation: 'daily' });
  mount();
  expect(await screen.findByText('Stale')).toBeVisible();
  expect(screen.queryByText('Best')).not.toBeInTheDocument();
  expect(screen.getAllByText('No capture')).toHaveLength(8);
  expect(await screen.findByText(/No history captured/)).toBeVisible();
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
it('expands the plot itself on stacked layouts', async () => {
  const user = userEvent.setup();
  mount();
  const chart = await screen.findByRole('slider');
  expect(chart).toHaveAttribute('viewBox', '0 0 320 185');
  await user.click(screen.getByRole('button', { name: 'Expand chart' }));
  expect(chart).toHaveAttribute('viewBox', '0 0 320 300');
});
