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
  vi.unstubAllGlobals();
});

beforeEach(() => {
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
 */
const ROUTE_LOAD_MS = 10_000;

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
