import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import { ADD_ROUTE_FORM_ID } from '@/features/airfare/ui/RouteEditor';
import { RouteList } from '@/features/airfare/ui/RouteList';

const TODAY = '2026-08-18';

const ROUTES: FareRoute[] = [
  {
    origin: 'LIM',
    destination: 'CUZ',
    flightDate: '2026-10-17',
    returnDate: null,
    currency: 'USD',
  },
  {
    origin: 'LIM',
    destination: 'SCL',
    flightDate: '2026-08-01',
    returnDate: null,
    currency: 'USD',
  },
];

function renderList(overrides: Partial<React.ComponentProps<typeof RouteList>> = {}) {
  const props = {
    routes: ROUTES,
    colours: new Map<string, string>(),
    selectedId: null,
    today: TODAY,
    onSelect: vi.fn(),
    onRemove: vi.fn(),
    onAdd: vi.fn(),
    onMove: vi.fn(),
    ...overrides,
  };
  // The submit button lives in the panel header on the page, tied to the form
  // by its `form` attribute rather than by containment.
  return {
    ...render(
      <>
        <RouteList {...props} />
        <button type="submit" form={ADD_ROUTE_FORM_ID}>
          Add route
        </button>
      </>,
    ),
    props,
  };
}

/**
 * The row for a route, by its accessible name.
 *
 * The pair is no longer one text node — the arrow is its own element so it can
 * be smaller than the codes, and a screen reader hears the word "to" instead
 * of "right arrow" — so `getByText` cannot reach it: the default matcher only
 * looks at an element's direct text children.
 */
function rowFor(origin: string, destination: string): HTMLElement {
  const between = String.raw`\s+to\s+`;
  return screen.getByRole('button', { name: new RegExp(origin + between + destination) });
}

describe('RouteList', () => {
  it('lists the watched routes', () => {
    renderList();
    expect(rowFor('LIM', 'CUZ')).toBeInTheDocument();
    expect(rowFor('LIM', 'SCL')).toBeInTheDocument();
  });

  it('puts the whole route on one line, each leg named for a screen reader', () => {
    /*
     * The arrows carry the direction visually and are hidden from the
     * accessibility tree — "up arrow 2026-10-17" is not what a departure date
     * sounds like — so the words travel beside them instead.
     */
    renderList({
      routes: [{ ...ROUTES[0], returnDate: '2026-10-28' }],
    });
    const row = rowFor('LIM', 'CUZ');
    // Shown the way this reader writes a date; ISO is what goes to disk.
    expect(row.textContent).toContain('departs17/10/2026');
    expect(row.textContent).toContain('returns28/10/2026');
    expect(row.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(2);
  });

  it('says nothing about a return when there is not one', () => {
    renderList({ routes: [{ ...ROUTES[0], returnDate: null }] });
    expect(rowFor('LIM', 'CUZ').textContent).not.toContain('returns');
  });

  it('carries the colour its arc is drawn in', () => {
    // Eight arcs leave Lima together; without this the reader cannot tell
    // which line belongs to the row they are looking at.
    const colours = new Map([[routeId(ROUTES[0]), '#5cb8ab']]);
    renderList({ colours });
    const swatch = rowFor('LIM', 'CUZ').querySelector('[class*="swatch"]') as HTMLElement;
    expect(swatch.style.background).toBe('rgb(92, 184, 171)');
  });

  it('marks a route whose departure has passed', () => {
    // Its history stays — that is what an archive is for — but nothing more
    // will be collected, and the reader should not have to work out why the
    // series stopped.
    renderList();
    expect(screen.getByText('Departed')).toBeInTheDocument();
  });

  it('keeps the fields on screen rather than behind a control', () => {
    // Adding a route is what this panel is for. A form that has to be opened
    // first puts a step in front of the only action here.
    renderList();
    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Origin')).toBeInTheDocument();
    expect(screen.getByLabelText('Return (optional)')).toBeInTheDocument();
  });

  it('adds a route from the fields', async () => {
    const user = userEvent.setup();
    const { props } = renderList();

    await user.clear(screen.getByLabelText('Origin'));
    await user.type(screen.getByLabelText('Origin'), 'LIM');
    await user.type(screen.getByLabelText('Destination'), 'MAD');
    const departure = screen.getByLabelText('Departure');
    await user.clear(departure);
    await user.type(departure, '2026-12-01');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(props.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'LIM', destination: 'MAD', flightDate: '2026-12-01' }),
    );
  });

  it('lets a route be dragged to another position', () => {
    // Order is not decoration on this list: the collector spends its daily
    // request budget down it, so dragging to the top is a statement about
    // which route matters when the budget will not cover everything.
    const { props } = renderList();
    const rows = screen.getAllByRole('listitem');

    fireEvent.dragStart(rows[1]);
    fireEvent.drop(rows[0]);

    expect(props.onMove).toHaveBeenCalledWith('LIM|SCL|2026-08-01|', 'LIM|CUZ|2026-10-17|');
  });

  it('reorders from the keyboard too', async () => {
    // Neither list this mechanism came from could be reordered without a
    // mouse. That is fixed in the shared hook, and asserted where it is used.
    const user = userEvent.setup();
    const { props } = renderList();

    // The label is a span; the focusable thing is the row's own button.
    rowFor('LIM', 'SCL').focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');

    expect(props.onMove).toHaveBeenCalledWith('LIM|SCL|2026-08-01|', 'LIM|CUZ|2026-10-17|');
  });

  it('still offers the fields when nothing is watched yet', () => {
    renderList({ routes: [] });
    expect(screen.getByText(/no routes watched yet/i)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
  });
});
