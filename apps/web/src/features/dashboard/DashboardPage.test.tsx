import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
      likeCount: 2,
      retweetCount: 3,
      replyCount: 4,
      url: 'https://x.com/a/1',
    },
    {
      id: '2',
      date: '2026-01-02',
      text: 'reply anon',
      isReply: true,
      likeCount: 5,
      retweetCount: 6,
      replyCount: 7,
      url: 'https://x.com/a/2',
    },
  ],
};

const IDLE = { handle: 'thsottiaux', state: 'idle', scroll: 0, new: 0, error: null };

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
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <DashboardPage />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

it('separates captured posts and replies with metrics and links', async () => {
  stubApi(IDLE);
  renderPage();

  expect(await screen.findByText('post anon')).toBeInTheDocument();
  expect(screen.getByText('reply anon')).toBeInTheDocument();
  expect(screen.getByText(/♥ 2/)).toBeInTheDocument();
  expect(screen.getAllByRole('link', { name: 'Open on X' })).toHaveLength(2);
});

it('asks for a capture when Refresh is pressed', async () => {
  const calls = stubApi(IDLE);
  renderPage();

  await userEvent.click(await screen.findByRole('button', { name: 'Refresh' }));

  expect(calls.some((call) => call.startsWith('POST') && call.endsWith('/refresh'))).toBe(true);
});

it('disables the button and shows progress while a capture runs', async () => {
  stubApi({ ...IDLE, state: 'running', scroll: 7, new: 12 });
  renderPage();

  expect(await screen.findByRole('button', { name: 'Refreshing…' })).toBeDisabled();
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
