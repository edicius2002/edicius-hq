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
      return Response.json({ status: 'ok' });
    }),
  );
});

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
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
    expect(screen.getByText('Coming soon.')).toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent('API online');
  });

  it('navigates between the four sidebar tabs', async () => {
    const user = userEvent.setup();
    renderAt('/dashboard');

    const nav = screen.getByRole('navigation');

    await user.click(within(nav).getByRole('link', { name: 'Finance' }));
    expect(await screen.findByRole('heading', { name: 'Finance' })).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Greenlight' }));
    expect(await screen.findByRole('heading', { name: 'Greenlight' })).toBeInTheDocument();
    expect(screen.getByText(/CSV weekly analytics/i)).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Investing' }));
    expect(await screen.findByRole('heading', { name: 'Investing' })).toBeInTheDocument();

    await user.click(within(nav).getByRole('link', { name: 'Dashboard' }));
    expect(await screen.findByRole('heading', { name: 'Dashboard' })).toBeInTheDocument();
  });

  it('shows NotFound for unknown routes', async () => {
    renderAt('/does-not-exist');
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
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
