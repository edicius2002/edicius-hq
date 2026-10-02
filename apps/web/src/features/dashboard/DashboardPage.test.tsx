import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  clearLocalSession: vi.fn(),
  subscribeToAuth: (callback: (event: string, session: { user: { id: string } }) => void) => {
    callback('INITIAL_SESSION', { user: { id: 'owner' } });
    return () => {};
  },
  getAccessToken: vi.fn(async () => null),
}));
const tweetData = vi.hoisted(() => ({
  TWEET_WINDOW_MS: 48 * 60 * 60 * 1000,
  fetchTweets: vi.fn(),
  subscribeTweets: vi.fn(() => () => {}),
}));

vi.mock('@/shared/auth/supabaseAuth', () => auth);
const codex = vi.hoisted(() => ({ fetchCodexResets: vi.fn() }));

vi.mock('./data/supabaseTweets', () => tweetData);
vi.mock('./fx/data', () => ({
  fetchLatest: async () => [],
  fetchHistory: async () => ({ points: [], aggregation: 'observations' }),
  subscribeFxObservations: () => () => {},
}));
// The card reads codex-resets.com through this client, which has tests of its
// own; this page test is about the layout it draws, not the provider's wire.
vi.mock('@/shared/api/codexResets', () => codex);

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
  tweetData.fetchTweets.mockResolvedValue(
    TWEETS.tweets.map((tweet, index) => ({
      ...tweet,
      date: new Date(Date.now() - (index + 1) * 60 * 60 * 1000).toISOString(),
    })),
  );
  if (resets instanceof Response) {
    codex.fetchCodexResets.mockRejectedValue(new Error(`HTTP ${resets.status}`));
  } else {
    codex.fetchCodexResets.mockResolvedValue(resets);
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${url}`);
      return Response.json(TWEETS);
    }),
  );
  return calls;
}

function renderPage(client = new QueryClient({ defaultOptions: { queries: { retry: false } } })) {
  return render(
    <QueryClientProvider client={client}>
      <DashboardPage />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

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

  const latest = screen.getByRole('heading', { name: 'Latest Codex limit reset' });
  expect(
    latest.compareDocumentPosition(await screen.findByRole('heading', { name: 'Posts' })),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(screen.getByText('53')).toBeInTheDocument();
  expect(screen.getByText('6.9d')).toBeInTheDocument();
  expect(screen.getByText('67.7d')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Codex reset history' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '1 banked reset on 2026-09-12' })).toBeInTheDocument();
  expect(
    screen.queryByText(/Independent tracker; not affiliated with OpenAI/),
  ).not.toBeInTheDocument();
});

it('keeps reset cards mounted while external data loads', async () => {
  stubApi();
  codex.fetchCodexResets.mockReturnValue(new Promise(() => {}));
  renderPage();

  expect(screen.getByRole('heading', { name: 'Latest Codex limit reset' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Codex reset history' })).toBeInTheDocument();
  expect(screen.getByText('Avg. miracle interval')).toBeInTheDocument();
  expect(screen.getByRole('status', { name: /loading codex reset history/i })).toBeInTheDocument();
  expect(screen.queryByText('0d')).not.toBeInTheDocument();
});

it('omits tweets older than 48 hours', async () => {
  stubApi();
  tweetData.fetchTweets.mockResolvedValue([
    { ...TWEETS.tweets[0], date: new Date(Date.now() - 49 * 60 * 60 * 1000).toISOString() },
    { ...TWEETS.tweets[1], date: new Date(Date.now() - 47 * 60 * 60 * 1000).toISOString() },
  ]);
  renderPage();

  expect(await screen.findByText('reply anon')).toBeInTheDocument();
  expect(screen.queryByText('post anon')).not.toBeInTheDocument();
});

it('removes a tweet when the live clock passes 48 hours without refetching', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
  stubApi();
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(
    ['tweets', 'thsottiaux'],
    [{ ...TWEETS.tweets[0], date: '2026-09-30T12:00:01Z' }],
  );
  renderPage(client);

  expect(screen.getByText('post anon')).toBeInTheDocument();
  await act(async () => {
    vi.advanceTimersByTime(30_000);
  });
  expect(screen.queryByText('post anon')).not.toBeInTheDocument();
  expect(screen.getByText('No posts in the last 48 hours.')).toBeInTheDocument();
  expect(tweetData.fetchTweets).not.toHaveBeenCalled();
});

it('shows the 48-hour empty state when the query returns no tweets', async () => {
  stubApi();
  tweetData.fetchTweets.mockResolvedValue([]);
  renderPage();

  expect(await screen.findByText('No posts in the last 48 hours.')).toBeInTheDocument();
  expect(screen.queryByText(/Nothing captured yet/)).not.toBeInTheDocument();
});

it.each([
  ['Posts', false, 'No replies in the last 48 hours.'],
  ['Replies', true, 'No posts in the last 48 hours.'],
])('keeps both columns when only %s has tweets', async (_title, isReply, emptyLine) => {
  stubApi();
  tweetData.fetchTweets.mockResolvedValue([
    { ...TWEETS.tweets[0], isReply, date: new Date().toISOString() },
  ]);
  renderPage();

  expect(await screen.findByText('post anon')).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Posts' })).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Replies' })).toBeInTheDocument();
  expect(screen.getByText(emptyLine)).toBeInTheDocument();
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

it('retains captured posts when a background refresh fails', async () => {
  stubApi();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  renderPage(client);
  const post = await screen.findByText('post anon');
  tweetData.fetchTweets.mockRejectedValueOnce(new Error('offline'));
  await act(async () => {
    await client.invalidateQueries({ queryKey: ['tweets'] });
  });
  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(post).toBeInTheDocument();
});

it('sets the USD/PEN gadget beside the Codex reset cards, above the posts', async () => {
  stubApi();
  renderPage();

  const gadget = screen.getByRole('region', { name: 'USD / PEN' });
  const latest = screen.getByRole('heading', { name: 'Latest Codex limit reset' });
  const history = screen.getByRole('heading', { name: 'Codex reset history' });
  const overview = gadget.parentElement!;
  expect(overview).toContainElement(latest);
  expect(overview).toContainElement(history);
  expect(latest.compareDocumentPosition(gadget)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    gadget.compareDocumentPosition(
      await screen.findByRole('heading', { level: 2, name: '@thsottiaux' }),
    ),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

it('shows five clocks in PST, PT, PER, EST, ARG order and keeps a hidden page heading', () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-01T15:04:00Z'));
  stubApi();
  renderPage();

  const title = screen.getByRole('heading', { level: 1, name: 'Dashboard' });
  expect(title).toHaveClass(/srOnly/);
  expect(screen.getByRole('region', { name: 'Dashboard' })).toContainElement(title);
  expect(screen.getByLabelText('PST 07:04')).toBeInTheDocument();
  expect(screen.getByLabelText('PT 08:04')).toBeInTheDocument();
  expect(
    screen
      .getAllByLabelText(/^(PST|PT|PER|EST|ARG) \d{2}:\d{2}$/)
      .map((clock) => clock.getAttribute('aria-label')?.split(' ')[0]),
  ).toEqual(['PST', 'PT', 'PER', 'EST', 'ARG']);
});
