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

const RESETS = {
  source: 'codex-resets.com',
  fetchedAt: '2026-09-14T15:00:00Z',
  generatedAt: '2026-09-14T14:59:00Z',
  stale: false,
  latestReset: {
    id: 'reset-2',
    resetType: 'banked',
    announcedAt: '2026-09-12T08:09:17Z',
    text: 'Banked reset landed',
    source: {
      type: 'x_post',
      author: 'thsottiaux',
      url: 'https://x.com/thsottiaux/status/reset-2',
    },
  },
  stats: { total: 53, avgIntervalDays: 6.9, longestIntervalDays: 67.7 },
  resets: [
    {
      id: 'reset-1',
      resetType: 'regular',
      announcedAt: '2026-09-01T04:30:00Z',
      text: 'Regular reset landed',
      source: {
        type: 'x_post',
        author: 'thsottiaux',
        url: 'https://x.com/thsottiaux/status/reset-1',
      },
    },
    {
      id: 'reset-2',
      resetType: 'banked',
      announcedAt: '2026-09-12T08:09:17Z',
      text: 'Banked reset landed',
      source: {
        type: 'x_post',
        author: 'thsottiaux',
        url: 'https://x.com/thsottiaux/status/reset-2',
      },
    },
  ],
};

/**
 * One stub for both endpoints the page talks to.
 *
 * Routing on the URL rather than on call order, because the page fires the
 * tweet query and the refresh poll together and the order between them is not
 * this component's promise to keep.
 */
function stubApi(refresh: Record<string, unknown>, resets: Response | object = RESETS) {
  const calls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      if (url.endsWith('/refresh')) return Response.json(refresh);
      if (url.endsWith('/api/codex-resets')) {
        return resets instanceof Response ? resets : Response.json(resets);
      }
      return Response.json(TWEETS);
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
  expect(screen.getAllByRole('img', { name: '@thsottiaux' })).toHaveLength(2);
});

it('places live reset summary and calendar above the preserved tweet columns', async () => {
  stubApi(IDLE);
  renderPage();

  const latest = await screen.findByRole('heading', { name: 'Latest Codex limit reset' });
  expect(latest.compareDocumentPosition(screen.getByRole('heading', { name: 'Posts' }))).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  );
  expect(screen.getByText('53')).toBeInTheDocument();
  expect(screen.getByText('6.9d')).toBeInTheDocument();
  expect(screen.getByText('67.7d')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Codex reset history' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /banked reset.*2026-09-12/i })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Codex Resets' }).closest('p')).toHaveTextContent(
    'Data by Codex Resets',
  );
});

it('keeps tweets visible while reset data is unavailable instead of showing zero statistics', async () => {
  stubApi(IDLE, new Response('unavailable', { status: 503 }));
  renderPage();

  expect(await screen.findByText('post anon')).toBeInTheDocument();
  expect(await screen.findByRole('alert', { name: /Codex reset data/i })).toHaveTextContent(
    /could not refresh/i,
  );
  expect(screen.queryByText('0d')).not.toBeInTheDocument();
});

it('labels cached reset data with the exact age while retaining its values', async () => {
  stubApi(IDLE, { ...RESETS, stale: true });
  renderPage();

  expect(await screen.findByText('53')).toBeInTheDocument();
  expect(screen.getByRole('status', { name: /Codex reset data/i })).toHaveTextContent(
    /cached data/i,
  );
  expect(screen.getByRole('status', { name: /Codex reset data/i })).toHaveTextContent(
    /Sep 14, 2026/i,
  );
});

it('shows the last completed refresh relatively, with its exact time on hover', async () => {
  const finishedAt = new Date(Date.now() - 3 * 60_000).toISOString();
  stubApi({ ...IDLE, finishedAt });
  renderPage();

  const updated = await screen.findByText('Updated 3 minutes ago');

  const title = updated.getAttribute('title') ?? '';
  expect(title).toContain(
    new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(finishedAt)),
  );
  expect(title).toMatch(/\d{1,2}:\d{2}/);
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
