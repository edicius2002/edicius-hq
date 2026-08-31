import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { DashboardPage } from './DashboardPage';

const TWEETS = {
  handle: 'thsottiaux',
  tweets: [
    {
      id: '1',
      date: '2026-01-01',
      text: 'post anon',
      isReply: false,
      url: 'https://x.com/a/1',
    },
    {
      id: '2',
      date: '2026-01-02',
      text: 'reply anon',
      isReply: true,
      url: 'https://x.com/a/2',
    },
  ],
};

const IDLE = {
  handle: 'thsottiaux',
  state: 'idle',
  scroll: 0,
  new: 0,
  error: null,
  finishedAt: null,
};

/**
 * One stub for both endpoints the page talks to.
 *
 * Routing on the URL rather than on call order, because the page fires the
 * tweet query and the refresh poll together and the order between them is not
 * this component's promise to keep.
 */
function stubApi(refresh: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return Response.json(url.endsWith('/refresh') ? refresh : TWEETS);
    }),
  );
  return calls;
}

function renderPage() {
  return render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DashboardPage />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

it('separates captured posts and replies with links', async () => {
  stubApi(IDLE);
  renderPage();

  expect(await screen.findByText('post anon')).toBeInTheDocument();
  expect(screen.getByText('reply anon')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Open on X' })).toHaveLength(2);
});

it('shows the last completed refresh relatively, with its exact time on hover', async () => {
  const finishedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  stubApi({ ...IDLE, finishedAt });
  renderPage();

  const updated = await screen.findByText('Updated 3 minutes ago');

  expect(updated).toHaveAttribute('title', new Intl.DateTimeFormat().format(new Date(finishedAt)));
  expect(screen.queryByRole('button', { name: /Refresh/ })).not.toBeInTheDocument();
});

it('says when no refresh has completed yet', async () => {
  stubApi(IDLE);
  renderPage();

  expect(await screen.findByText('Never updated')).toBeInTheDocument();
});

it('keeps the last completed refresh visible while a capture reports progress', async () => {
  const finishedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  stubApi({ ...IDLE, state: 'running', scroll: 7, new: 12, finishedAt });
  renderPage();

  expect(await screen.findByText('Updated 3 minutes ago')).toBeInTheDocument();
  expect(screen.getByText(/Scrolled 7 · 12 new/)).toBeInTheDocument();
});

it('shows why a capture failed', async () => {
  stubApi({
    ...IDLE,
    state: 'failed',
    error: 'Sesión X inválida; ejecuta import_session.py.',
  });
  renderPage();

  expect(await screen.findByRole('alert')).toHaveTextContent('import_session.py');
});

it('keeps the API watcher running when the Dashboard unmounts', () => {
  const calls = stubApi(IDLE);
  const { unmount } = renderPage();

  unmount();

  expect(calls.some((call) => call.startsWith('DELETE') && call.endsWith('/watch'))).toBe(false);
});
