import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactNode } from 'react';
import { RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppErrorBoundary } from '@/app/layout/AppErrorBoundary';
import { AppProviders } from '@/app/providers/AppProviders';
import { createAppMemoryRouter } from '@/app/router/createAppRouter';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

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

describe('Shell navigation', () => {
  it('redirects / to Dashboard coming soon', async () => {
    renderAt('/');
    expect(await arrivesAt('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Coming soon.')).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('API online');
  });

  it('navigates between the five sidebar tabs', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard');

    const nav = screen.getByRole('navigation');

    await user.click(within(nav).getByRole('link', { name: 'Finance' }));
    expect(await arrivesAt('Finance')).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Greenlight' }));
    expect(await arrivesAt('Greenlight')).toBeInTheDocument();
    expect(screen.getByText(/Deliverable value by week and month/i)).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Investing' }));
    expect(await arrivesAt('Investing')).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Airfare' }));
    expect(await arrivesAt('Airfare')).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }));
    expect(await arrivesAt('Dashboard')).toBeInTheDocument();
  });

  it('shows NotFound for unknown routes', async () => {
    renderAt('/does-not-exist');
    expect(await arrivesAt('Page not found')).toBeInTheDocument();
  });
});

describe('Investing chart-first workspace', () => {
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
