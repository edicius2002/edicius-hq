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
 * does under a full parallel run: measured, the four-tab walk takes 16.8s and
 * dies waiting for Investing, the largest chunk of the four. It passes in 3.2s
 * on a native Linux filesystem. A ceiling is not a delay — an arriving route
 * resolves immediately — so it is set well clear of the measurement rather than
 * beside it, and under the 45s `testTimeout` in `vite.config.ts`, which has to
 * cover all four waits in one test.
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

  it('navigates between the four sidebar tabs', async () => {
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

    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }));
    expect(await arrivesAt('Dashboard')).toBeInTheDocument();
  });

  it('shows NotFound for unknown routes', async () => {
    renderAt('/does-not-exist');
    expect(await arrivesAt('Page not found')).toBeInTheDocument();
  });
});

describe('Investing chart-first workspace', () => {
  it('keeps watchlist and positions in one switchable market rail', async () => {
    const user = userEvent.setup();
    renderAt('/investing');
    await arrivesAt('Investing');

    expect(screen.getByRole('tab', { name: 'Watchlist' })).toHaveAttribute('aria-selected', 'true');
    await user.click(screen.getByRole('tab', { name: 'Positions' }));

    expect(screen.getByRole('tab', { name: 'Positions' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Nothing held yet.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Search a symbol' })).not.toBeInTheDocument();
  });

  it('can devote the workspace to the chart and returns with Escape', async () => {
    const user = userEvent.setup();
    renderAt('/investing');
    await arrivesAt('Investing');

    await user.click(screen.getByRole('button', { name: 'Focus chart' }));

    expect(screen.getByRole('region', { name: 'Focused investing chart' })).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Markets' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Exit focus' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.keyboard('{Escape}');

    expect(screen.getByRole('heading', { name: 'Investing' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Markets' })).toBeInTheDocument();
  });

  it('collapses and restores the market rail without entering focus mode', async () => {
    const user = userEvent.setup();
    renderAt('/investing');
    await arrivesAt('Investing');

    await user.click(screen.getByRole('button', { name: 'Hide markets' }));
    expect(screen.queryByRole('region', { name: 'Markets' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Show markets' }));
    expect(screen.getByRole('region', { name: 'Markets' })).toBeInTheDocument();
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
