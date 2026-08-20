import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import type { RowReport } from '@/features/airfare/lib/rowReport';
import { ADD_ROUTE_FORM_ID } from '@/features/airfare/ui/RouteEditor';
import { RouteList } from '@/features/airfare/ui/RouteList';

const TODAY = '2026-08-18';

const ROUTES: FareRoute[] = [
  { origin: 'LIM', destination: 'CUZ', month: '2026-10', currency: 'USD' },
  // A month the calendar has already left, so the row says "Departed".
  { origin: 'LIM', destination: 'SCL', month: '2026-07', currency: 'USD' },
];

function renderList(overrides: Partial<React.ComponentProps<typeof RouteList>> = {}) {
  const props = {
    routes: ROUTES,
    colours: new Map<string, string>(),
    selectedId: null,
    today: TODAY,
    collecting: [] as readonly string[],
    reports: new Map<string, RowReport>(),
    onSelect: vi.fn(),
    onRemove: vi.fn(),
    onCollect: vi.fn(),
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

  it('puts the whole route on one line, its month named for a screen reader', () => {
    /*
     * The arrow carries the direction visually and is hidden from the
     * accessibility tree — "up arrow March 2027" is not what a departure
     * sounds like — so the words travel beside it instead.
     */
    renderList({ routes: [ROUTES[0]] });
    const row = rowFor('LIM', 'CUZ');
    // Named rather than numbered — 12.114 — so it cannot be read as a day.
    expect(row.textContent).toContain('departs inOctober 2026');
    expect(row.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThanOrEqual(2);
  });

  it('says nothing about a return, which a month cannot have', () => {
    // 12.113: thirty-one departures have no single return date to share.
    renderList({ routes: [ROUTES[0]] });
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

  it('marks a route whose month the calendar has left', () => {
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
    expect(screen.getByRole('combobox', { name: 'Departure month' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Departure year' })).toBeInTheDocument();
  });

  it('adds a route from the fields', async () => {
    const user = userEvent.setup();
    const { props } = renderList();

    await user.clear(screen.getByLabelText('Origin'));
    await user.type(screen.getByLabelText('Origin'), 'LIM');
    await user.type(screen.getByLabelText('Destination'), 'MAD');
    fireEvent.change(screen.getByRole('combobox', { name: 'Departure month' }), {
      target: { value: '12' },
    });
    await user.click(screen.getByRole('button', { name: /add route/i }));

    // A city pair and a month, which is the whole of what a watch is —
    // 12.260, and 12.262 for the two dropdowns that name the month. The year
    // is left on its default, which today is this one.
    expect(props.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'LIM',
        destination: 'MAD',
        month: '2026-12',
      }),
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

    expect(props.onMove).toHaveBeenCalledWith('LIM|SCL|2026-07', 'LIM|CUZ|2026-10');
  });

  it('reorders from the keyboard too', async () => {
    // Neither list this mechanism came from could be reordered without a
    // mouse. That is fixed in the shared hook, and asserted where it is used.
    const user = userEvent.setup();
    const { props } = renderList();

    // The label is a span; the focusable thing is the row's own button.
    rowFor('LIM', 'SCL').focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');

    expect(props.onMove).toHaveBeenCalledWith('LIM|SCL|2026-07', 'LIM|CUZ|2026-10');
  });

  it('offers each row its own collection, named for the route it would collect', () => {
    // "Collect" on its own would be nine identical buttons in the
    // accessibility tree, and the mark that carries it visually says nothing
    // out loud at all.
    renderList();
    expect(
      screen.getByRole('button', { name: 'Collect LIM → CUZ in October 2026 now' }),
    ).toBeInTheDocument();
  });

  it('collects the route whose own control was pressed', async () => {
    const user = userEvent.setup();
    const { props } = renderList();

    await user.click(screen.getByRole('button', { name: /^Collect LIM → CUZ/ }));

    expect(props.onCollect).toHaveBeenCalledTimes(1);
    expect(props.onCollect).toHaveBeenCalledWith(ROUTES[0]);
  });

  it('offers no collection for a month the calendar has left', () => {
    // The provider answers nothing about a flight that has left, so there is
    // no press to invite. Absent rather than disabled: the row already says
    // "Departed", and a greyed button beside it only raises the question.
    renderList();
    expect(screen.queryByRole('button', { name: /^Collect LIM → SCL/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Stop watching LIM → SCL/ })).toBeInTheDocument();
  });

  it('holds down only the row whose own collection is in flight', () => {
    // One row's press must not reach across and grey out the rest. The
    // watchlist is a list of independent routes and this is a per-route
    // action.
    renderList({ collecting: [routeId(ROUTES[0])] });

    const busy = screen.getByRole('button', { name: /^Collecting LIM → CUZ/ });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    // Removing is a different action on the same row and stays available: a
    // route can be dropped from the watchlist mid-look.
    expect(screen.getByRole('button', { name: /^Stop watching LIM → CUZ/ })).toBeEnabled();
  });

  it('leaves every other row pressable while one is collecting', () => {
    const third: FareRoute = {
      origin: 'LIM',
      destination: 'MAD',
      month: '2026-12',
      currency: 'USD',
    };
    renderList({ routes: [...ROUTES, third], collecting: [routeId(ROUTES[0])] });

    expect(screen.getByRole('button', { name: /^Collecting LIM → CUZ/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /^Collect LIM → MAD/ })).toBeEnabled();
  });

  it('reports what the collection came back with on the row that asked', () => {
    // A press that quietly does nothing is a broken button as far as the
    // reader is concerned — decisions 8.8 and 8.41, the same rule the pass
    // itself follows.
    renderList({
      reports: new Map([
        [routeId(ROUTES[0]), { ok: true, text: 'Collected: 14 flights, cheapest $412.00.' }],
      ]),
    });
    expect(screen.getByText('Collected: 14 flights, cheapest $412.00.')).toBeInTheDocument();
  });

  it('says a refusal out loud rather than dropping it', () => {
    renderList({
      reports: new Map([
        [routeId(ROUTES[0]), { ok: false, text: 'Refused: no-offers — nothing on that day.' }],
      ]),
    });
    const line = screen.getByText('Refused: no-offers — nothing on that day.');
    expect(line.className).toMatch(/refused/);
    // The region has to be in the document before its text changes, or a
    // screen reader has nothing to notice. Every row carries an empty one.
    expect(line).toHaveAttribute('aria-live', 'polite');
  });

  it('still offers the fields when nothing is watched yet', () => {
    renderList({ routes: [] });
    expect(screen.getByText(/no routes watched yet/i)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
  });
});
