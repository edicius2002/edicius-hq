import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  clearLocalSession: vi.fn(),
  getAccessToken: vi.fn(async () => null),
}));
const tweetData = vi.hoisted(() => ({
  fetchTweets: vi.fn(),
  subscribeTweets: vi.fn(() => () => {}),
}));

vi.mock('@/shared/auth/supabaseAuth', () => auth);
vi.mock('./data/supabaseTweets', () => tweetData);

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
function stubApi(resets: Response | object = RESETS) {
  const calls: string[] = [];
  tweetData.fetchTweets.mockResolvedValue(TWEETS.tweets);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
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
  stubApi();
  renderPage();

  expect(await screen.findByText('post anon')).toBeInTheDocument();
  expect(screen.getByText('reply anon')).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Open on X' })).toHaveLength(2);
  expect(screen.getAllByRole('img', { name: '@thsottiaux' })).toHaveLength(2);
});

it('places live reset summary and calendar above the preserved tweet columns', async () => {
  stubApi();
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
  expect(
    screen.queryByText(/Independent tracker; not affiliated with OpenAI/),
  ).not.toBeInTheDocument();
});

it('keeps tweets visible while reset data is unavailable instead of showing zero statistics', async () => {
  stubApi(new Response('unavailable', { status: 503 }));
  renderPage();

  expect(await screen.findByText('post anon')).toBeInTheDocument();
  expect(screen.queryByText(/Codex reset data could not refresh/i)).not.toBeInTheDocument();
  expect(screen.queryByText(/Posts and replies remain available below/i)).not.toBeInTheDocument();
  expect(screen.queryByText('0d')).not.toBeInTheDocument();
});

it('shows cached reset values without an operational warning', async () => {
  stubApi({ ...RESETS, stale: true });
  renderPage();

  expect(await screen.findByText('53')).toBeInTheDocument();
  expect(screen.queryByText(/Could not refresh; showing cached data/i)).not.toBeInTheDocument();
});

it('omits X collector chrome while retaining captured posts', async () => {
  stubApi();
  renderPage();

  expect(await screen.findByText('post anon')).toBeInTheDocument();
  expect(screen.queryByText(/Updated /)).not.toBeInTheDocument();
  expect(screen.queryByText('Never updated')).not.toBeInTheDocument();
  expect(screen.queryByText('X collector is running.')).not.toBeInTheDocument();
  expect(screen.queryByText(/X collector failed/i)).not.toBeInTheDocument();
});

it('keeps the API watcher running when the Dashboard unmounts', () => {
  const calls = stubApi();
  const { unmount } = renderPage();

  unmount();

  expect(calls.some((call) => call.startsWith('DELETE') && call.endsWith('/watch'))).toBe(false);
});
