import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '@/app/App';
import { AppErrorBoundary } from '@/app/layout/AppErrorBoundary';
import { AppProviders } from '@/app/providers/AppProviders';
import { createAppMemoryRouter } from '@/app/router/createAppRouter';
import { clearToken, writeToken } from '@/shared/auth/session';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** A quiet day's ledger, for the shell walk that now passes through Airfare. */
const FARE_SPEND = {
  day: '2026-08-21',
  resetsAt: '2026-08-22T00:00:00+00:00',
  spent: 0,
  ceiling: null,
  remaining: null,
  busiestOnRecord: 329,
  kinds: [],
};

beforeEach(() => {
  // The layout tests exercise the chart shell, not canvas pixels. jsdom emits
  // a noisy "not implemented" error before returning null without this stub.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/kv/')) {
        return new Response(null, { status: 404 });
      }
      // Shell navigation must not depend on a market upstream being reachable.
      if (url.includes('/api/market/quotes')) {
        return Response.json({ quotes: [], failed: [] });
      }
      if (url.includes('/api/market/bars')) {
        return Response.json({ symbol: 'AAPL', timeframe: '1d', provider: 'test', bars: [] });
      }
      // Airfare's header reads the day's request spend — the catch-all below is
      // `{ status: 'ok' }`, which is not a document any of these endpoints
      // answers with and which the other pages survive only because everything
      // they read from it is optional.
      if (url.includes('/api/fares/spend')) {
        return Response.json(FARE_SPEND);
      }
      return Response.json({ status: 'ok' });
    }),
  );
});

/**
 * Routes are code-split, so arriving at one waits on a dynamic import that Vite
 * compiles on demand — not on a render. The default one-second budget is a
 * render budget, and on a loaded machine the first visit to a route overruns
 * it, which made this the only intermittently red test in the suite.
 *
 * Ten seconds was still short of what this repository's `/mnt/d` drvfs mount
 * does under a full parallel run: measured, the tab walk takes 16.8s over four
 * routes and
 * dies waiting for Investing, the largest chunk of the four. It passes in 3.2s
 * on a native Linux filesystem. A ceiling is not a delay — an arriving route
 * resolves immediately — so it is set well clear of the measurement rather than
 * beside it, and under the 45s `testTimeout` in `vite.config.ts`, which has to
 * cover every wait in one test — five of them since Airfare joined the walk.
 */
const ROUTE_LOAD_MS = 25_000;

function arrivesAt(name: string) {
  return screen.findByRole('heading', { name }, { timeout: ROUTE_LOAD_MS });
}

function renderAt(path: string) {
  const router = createAppMemoryRouter([path]);
  return render(
    <AppErrorBoundary>
      <AppProviders>
        <RouterProvider router={router} />
      </AppProviders>
    </AppErrorBoundary>,
  );
}

/**
 * The links live inside a dropdown that closes on every navigation — 12.117's
 * follow-up replacing the fixed sidebar with a top-bar menu — so each hop has
 * to reopen it before the next link is reachable.
 */
async function openMenu(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Menu' }));
  // Named, not bare `getByRole('navigation')` — Finance's diagram canvas
  // carries its own `nav` landmark, and a route holding both is exactly the
  // case an unnamed query cannot tell apart.
  return screen.getByRole('navigation', { name: 'Primary' });
}

describe('Shell navigation', () => {
  it('redirects / to Dashboard coming soon', async () => {
    renderAt('/');
    expect(await arrivesAt('Dashboard')).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('API online');
  });

  it('navigates between the five sidebar tabs', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard');

    let nav = await openMenu(user);
    await user.click(within(nav).getByRole('link', { name: 'Finance' }));
    expect(await arrivesAt('Finance')).toBeInTheDocument();

    nav = await openMenu(user);
    await user.click(within(nav).getByRole('link', { name: 'Greenlight' }));
    expect(await arrivesAt('Greenlight')).toBeInTheDocument();

    nav = await openMenu(user);
    await user.click(within(nav).getByRole('link', { name: 'Investing' }));
    expect(await arrivesAt('Investing')).toBeInTheDocument();

    nav = await openMenu(user);
    await user.click(within(nav).getByRole('link', { name: 'Airfare' }));
    expect(await arrivesAt('Airfare')).toBeInTheDocument();

    nav = await openMenu(user);
    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }));
    expect(await arrivesAt('Dashboard')).toBeInTheDocument();
  });

  it('shows NotFound for unknown routes', async () => {
    renderAt('/does-not-exist');
    expect(await arrivesAt('Page not found')).toBeInTheDocument();
  });
});

describe('Investing chart-first workspace', () => {
  it('imports positions into the portfolio and adds their symbols to the watchlist', async () => {
    const user = userEvent.setup();
    const stored = new Map<string, unknown>();

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const key = url.match(/\/api\/kv\/([^/?]+)/)?.[1];
        if (key) {
          if (init?.method === 'PUT') {
            const value = JSON.parse(String(init.body)).value;
            stored.set(key, value);
            return Response.json({ key, value });
          }
          return stored.has(key)
            ? Response.json({ key, value: stored.get(key) })
            : new Response(null, { status: 404 });
        }
        if (url.includes('/api/market/quotes')) return Response.json({ quotes: [], failed: [] });
        if (url.includes('/api/market/bars')) {
          return Response.json({ symbol: 'AAPL', timeframe: '1d', provider: 'test', bars: [] });
        }
        return Response.json({ status: 'ok' });
      }),
    );

    renderAt('/investing');
    await arrivesAt('Investing');
    await screen.findByRole('region', { name: 'Positions' }, { timeout: ROUTE_LOAD_MS });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Import' })).toBeEnabled());

    await user.upload(
      screen.getByLabelText('Positions file'),
      new File(
        [
          JSON.stringify({
            app: 'edicius-hq',
            kind: 'investing-positions',
            version: 1,
            exportedAt: '2026-08-31T12:00:00.000Z',
            positions: [{ symbol: 'MSFT', quantity: 2, averageCost: 400 }],
          }),
        ],
        'positions.json',
        { type: 'application/json' },
      ),
    );

    expect(
      within(await screen.findByRole('list', { name: 'Positions' })).getByRole('button', {
        name: /^MSFT/,
      }),
    ).toBeInTheDocument();
    expect(
      within(await screen.findByRole('list', { name: 'Watchlist' })).getByRole('button', {
        name: 'Stop following MSFT',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 positions imported, 0 updated.')).toBeInTheDocument();
  });

  it('sits the watchlist beside the chart and the positions under both of them', async () => {
    renderAt('/investing');
    await arrivesAt('Investing');

    const chart = screen.getByRole('region', { name: 'AAPL chart' });
    const watchlist = screen.getByRole('region', { name: 'Watchlist' });
    const positions = screen.getByRole('region', { name: 'Positions' });

    // Sharing a parent is what makes them two cells of one grid row, and two
    // cells of one row is the only arrangement in which they share a height.
    expect(watchlist.parentElement).toBe(chart.parentElement);

    // The positions are outside that row, so nothing constrains them to the
    // rail's column: they run the width of both cells beneath it.
    expect(positions.parentElement).not.toBe(chart.parentElement);
    expect(chart.parentElement?.contains(positions)).toBe(false);
    expect(
      positions.compareDocumentPosition(chart) & Node.DOCUMENT_POSITION_PRECEDING,
    ).toBeTruthy();

    // Both lists are on screen at once, which is the point of the rearrangement.
    expect(screen.getByText('Nothing held yet.')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Search a symbol' })).toBeInTheDocument();
  });

  it('puts a watchlist longer than the chart in a scrolling box of its own', async () => {
    // Forty rows is comfortably taller than any chart this page draws, which
    // is the case that decides whether the two panels still share a height or
    // the list drags the row down past the chart.
    const entries = Array.from({ length: 40 }, (_, index) => ({
      symbol: `SYM${index}`,
      name: `Symbol ${index} Incorporated`,
    }));

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('/api/kv/watchlist')) {
          return Response.json({ key: 'watchlist', value: { version: 1, entries } });
        }
        if (url.includes('/api/kv/')) return new Response(null, { status: 404 });
        if (url.includes('/api/market/quotes')) return Response.json({ quotes: [], failed: [] });
        if (url.includes('/api/market/bars')) {
          return Response.json({ symbol: 'AAPL', timeframe: '1d', provider: 'test', bars: [] });
        }
        return Response.json({ status: 'ok' });
      }),
    );

    renderAt('/investing');
    await arrivesAt('Investing');

    const list = await screen.findByRole('list', { name: 'Watchlist' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(40);

    // jsdom lays nothing out, so this cannot see the scrolling — what it can
    // see is that the rows have a box of their own to scroll in, and which
    // side of it the search field is on. The panel scrolling as a whole would
    // carry the field away with the rows, and a list long enough to scroll is
    // exactly when you least want the way to add to it scrolled away.
    const scroller = list.parentElement;
    const panel = screen.getByRole('region', { name: 'Watchlist' });
    const search = screen.getByRole('textbox', { name: 'Search a symbol' });

    expect(scroller).not.toBe(panel);
    expect(panel.contains(search)).toBe(true);
    expect(scroller?.contains(search)).toBe(false);
  });

  it('can devote the workspace to the chart and returns with Escape', async () => {
    const user = userEvent.setup();
    renderAt('/investing');
    await arrivesAt('Investing');

    await user.click(screen.getByRole('button', { name: 'Focus chart' }));

    expect(screen.getByRole('region', { name: 'Focused investing chart' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Watchlist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Positions' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit focus' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.keyboard('{Escape}');

    expect(screen.getByRole('heading', { name: 'Investing' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Watchlist' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Positions' })).toBeInTheDocument();
  });

  it('collapses and restores both market lists without entering focus mode', async () => {
    const user = userEvent.setup();
    renderAt('/investing');
    await arrivesAt('Investing');

    await user.click(screen.getByRole('button', { name: 'Hide markets' }));
    expect(screen.queryByRole('region', { name: 'Watchlist' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Positions' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show markets' }));
    expect(screen.getByRole('region', { name: 'Watchlist' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Positions' })).toBeInTheDocument();
  });
});

describe('AppErrorBoundary', () => {
  it('renders a fallback when a child throws', () => {
    function Boom(): ReactNode {
      throw new Error('boom');
    }

    render(
      <AppErrorBoundary>
        <Boom />
      </AppErrorBoundary>,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Something went wrong');
    expect(screen.getByText('boom')).toBeInTheDocument();
  });
});

/**
 * The shell gate.
 *
 * One decision around the router rather than a guard per route, so these tests
 * render `App` itself — the rest of this file goes around it, straight to
 * `RouterProvider`, because it is testing navigation rather than access.
 */
describe('The session gate', () => {
  afterEach(() => {
    clearToken();
  });

  it('renders the login screen when there is no session', () => {
    clearToken();
    render(<App />);

    expect(screen.getByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });

  it('renders the app when a session exists', async () => {
    writeToken('a-token');
    render(<App />);

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /sign in/i })).not.toBeInTheDocument(),
    );
  });

  it('falls back to the login screen when the stored token is refused', async () => {
    writeToken('a-stale-token');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({ detail: 'Not authenticated' }, { status: 401 })),
    );

    render(<App />);

    expect(await screen.findByRole('button', { name: /sign in/i })).toBeInTheDocument();
  });
});
