import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TopNav } from '@/app/layout/TopNav';
import { EDGE_ZONE, SWIPE_THRESHOLD } from '@/app/layout/TopNav';

/**
 * The narrow branch, which is the one jsdom does not reach on its own: the
 * hook behind it asks `matchMedia`, and jsdom answers `false` to every width.
 * `App.test` covers the wide branch through the same component and is left
 * alone for that reason — stubbing here rather than there is what keeps the
 * two from having to know about each other.
 *
 * The gesture is the part worth testing at this level. Its failure mode is not
 * "does not open" — that is obvious the first time anybody tries it — but
 * opening when it should not: a drawer that answers a vertical scroll, or a
 * drag that began in the middle of the Finance canvas, is a page you cannot
 * use with a thumb.
 */

function stubNarrow(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({
      matches,
      media: '',
      addEventListener: () => {},
      removeEventListener: () => {},
    })),
  );
}

function renderNav(path = '/dashboard') {
  // `ApiStatus` polls health through react-query; retries off so a rejected
  // fetch settles once instead of holding the test open.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <TopNav />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** One touch, described by where it starts and where it ends. */
function swipe(from: [number, number], to: [number, number], pointerType = 'touch') {
  fireEvent.pointerDown(window, { pointerId: 1, pointerType, clientX: from[0], clientY: from[1] });
  fireEvent.pointerMove(window, { pointerId: 1, pointerType, clientX: to[0], clientY: to[1] });
  fireEvent.pointerUp(window, { pointerId: 1, pointerType, clientX: to[0], clientY: to[1] });
}

const trigger = () => screen.getByRole('button', { name: 'Edicius HQ' });
const drawer = () => screen.queryByRole('navigation', { name: 'Primary' });

beforeEach(() => {
  stubNarrow(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the narrow shell', () => {
  it('shows the brand and the API status, and nothing else', () => {
    renderNav();

    expect(trigger()).toBeInTheDocument();
    expect(screen.getByRole('status')).toBeInTheDocument();
    // The control the wide branch uses; its absence is what makes the row fit.
    expect(screen.queryByRole('button', { name: 'Menu' })).not.toBeInTheDocument();
  });

  /*
   * Dashboard, Finance and Greenlight name their main section with
   * `aria-labelledby="page-title"`, and `App.test` asserts a heading by name.
   * Taking the title out of the row is a visual change; taking it out of the
   * tree would rename three pages to nothing.
   */
  it('keeps the page title in the tree while hiding it from the row', () => {
    renderNav('/investing');

    const heading = screen.getByRole('heading', { name: 'Investing' });
    expect(heading).toHaveAttribute('id', 'page-title');
  });

  it('opens the drawer when the brand is tapped', async () => {
    const user = userEvent.setup();
    renderNav();
    expect(drawer()).not.toBeInTheDocument();

    await user.click(trigger());

    const nav = drawer();
    expect(nav).toBeInTheDocument();
    expect(within(nav!).getAllByRole('link')).toHaveLength(5);
    expect(trigger()).toHaveAttribute('aria-expanded', 'true');
  });

  it('closes on Escape and gives the brand its focus back', async () => {
    const user = userEvent.setup();
    renderNav();
    await user.click(trigger());

    await user.keyboard('{Escape}');

    expect(drawer()).not.toBeInTheDocument();
    expect(trigger()).toHaveFocus();
  });

  it('closes when the scrim is pressed', async () => {
    const user = userEvent.setup();
    renderNav();
    await user.click(trigger());

    await user.click(screen.getByTestId('drawer-scrim'));

    expect(drawer()).not.toBeInTheDocument();
  });

  describe('the edge swipe', () => {
    it('opens on a rightward drag from the left edge', () => {
      renderNav();

      swipe([EDGE_ZONE - 1, 400], [EDGE_ZONE - 1 + SWIPE_THRESHOLD + 1, 400]);

      expect(drawer()).toBeInTheDocument();
    });

    it('closes on a leftward drag while open', async () => {
      const user = userEvent.setup();
      renderNav();
      await user.click(trigger());

      swipe([200, 400], [200 - SWIPE_THRESHOLD - 1, 400]);

      expect(drawer()).not.toBeInTheDocument();
    });

    /*
     * The Finance canvas starts at x=40 and the Airfare globe at x=61, both
     * under `touch-action: none`. A gesture that armed anywhere would fight
     * them for every horizontal drag on those two pages.
     */
    it('ignores a drag that starts past the edge zone', () => {
      renderNav();

      swipe([EDGE_ZONE + 5, 400], [EDGE_ZONE + 5 + SWIPE_THRESHOLD + 1, 400]);

      expect(drawer()).not.toBeInTheDocument();
    });

    it('ignores a mostly vertical drag, which is the page scrolling', () => {
      renderNav();

      swipe([5, 300], [5 + SWIPE_THRESHOLD + 1, 300 + SWIPE_THRESHOLD * 3]);

      expect(drawer()).not.toBeInTheDocument();
    });

    it('ignores a drag that never travels far enough', () => {
      renderNav();

      swipe([5, 400], [5 + SWIPE_THRESHOLD - 1, 400]);

      expect(drawer()).not.toBeInTheDocument();
    });

    it('ignores a mouse, which has the dropdown and the brand already', () => {
      renderNav();

      swipe([5, 400], [5 + SWIPE_THRESHOLD + 1, 400], 'mouse');

      expect(drawer()).not.toBeInTheDocument();
    });
  });

  it('leaves the gesture behind on the wide branch', () => {
    vi.unstubAllGlobals();
    stubNarrow(false);
    renderNav();

    swipe([5, 400], [5 + SWIPE_THRESHOLD + 1, 400]);

    expect(drawer()).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Menu' })).toBeInTheDocument();
  });
});
