import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import type { AirfareRequestProgress } from '@/features/airfare/data/airfareRequests';
import { RouteList } from '@/features/airfare/ui/RouteList';

const TODAY = '2026-08-18';

const ROUTES: FareRoute[] = [
  { origin: 'LIM', destination: 'CUZ', months: ['2026-10'], currency: 'USD' },
  // A month the calendar has already left, so the row says "Departed".
  { origin: 'LIM', destination: 'SCL', months: ['2026-07'], currency: 'USD' },
];

function renderList(overrides: Partial<React.ComponentProps<typeof RouteList>> = {}) {
  const props = {
    routes: ROUTES,
    colours: new Map<string, string>(),
    selectedId: null,
    today: TODAY,
    activeMonth: null as string | null,
    editing: null as FareRoute | null,
    collecting: [] as readonly string[],
    progress: new Map<string, AirfareRequestProgress>(),
    onSelect: vi.fn(),
    onOpenMonth: vi.fn(),
    onRemove: vi.fn(),
    onCollect: vi.fn(),
    onAdd: vi.fn(),
    onSave: vi.fn(),
    onClearEditing: vi.fn(),
    onMove: vi.fn(),
    ...overrides,
  };
  return {
    ...render(<RouteList {...props} />),
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
  it('fills the list with noninteractive route skeletons while the read is pending', () => {
    renderList({ routes: [], loading: true });
    expect(screen.getByRole('status', { name: 'Loading watched routes' })).toBeInTheDocument();
    expect(screen.getAllByTestId('route-skeleton')).toHaveLength(10);
    expect(screen.queryByText('No routes watched yet.')).not.toBeInTheDocument();
    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
  });

  it('keeps a failed route read distinct from a settled empty watchlist', () => {
    renderList({ routes: [], error: true });
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load watched routes');
    expect(screen.queryByText('No routes watched yet.')).not.toBeInTheDocument();
  });

  it('lists the watched routes', () => {
    renderList();
    expect(rowFor('LIM', 'CUZ')).toBeInTheDocument();
    expect(rowFor('LIM', 'SCL')).toBeInTheDocument();
  });

  it('gives each phone route its own row, fetch button and remove button', () => {
    const second: FareRoute = {
      origin: 'AQP',
      destination: 'LIM',
      months: ['2026-11'],
      currency: 'USD',
    };
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    );
    try {
      const view = renderList({ routes: [ROUTES[0], second] });
      const rows = screen.getByRole('list', { name: 'Watched routes' }).querySelectorAll('li');
      expect(rows).toHaveLength(2);
      expect(
        within(rows[0]).getByRole('button', { name: 'Fetch LIM → CUZ now, October 2026' }),
      ).toBeInTheDocument();
      fireEvent.click(
        within(rows[1]).getByRole('button', { name: 'Fetch AQP → LIM now, November 2026' }),
      );
      expect(view.props.onCollect).toHaveBeenCalledWith(second, '2026-11');
      fireEvent.click(within(rows[1]).getByRole('button', { name: 'Stop watching AQP → LIM' }));
      expect(view.props.onRemove).toHaveBeenCalledWith('AQP|LIM');
      view.unmount();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('selects another paired route before switching its direction on a later press', () => {
    const reverse: FareRoute = {
      origin: 'CUZ',
      destination: 'LIM',
      months: ['2026-11'],
      currency: 'USD',
    };
    const { props, rerender } = renderList({
      routes: [ROUTES[0], ROUTES[1], reverse],
      selectedId: 'LIM|SCL',
    });

    const outward = rowFor('LIM', 'CUZ');
    fireEvent.click(outward);
    expect(props.onSelect).toHaveBeenLastCalledWith('LIM|CUZ');
    expect(outward).not.toHaveAttribute('title', 'Switch to CUZ → LIM');

    rerender(<RouteList {...props} selectedId="LIM|CUZ" />);
    expect(rowFor('LIM', 'CUZ')).toHaveAttribute('title', 'Switch to CUZ → LIM');
    fireEvent.click(rowFor('LIM', 'CUZ'));
    expect(props.onSelect).toHaveBeenLastCalledWith('CUZ|LIM');
  });

  it('keeps reciprocal watches in one compact row and switches direction on press', () => {
    const reverse: FareRoute = {
      origin: 'CUZ',
      destination: 'LIM',
      months: ['2026-11'],
      currency: 'USD',
    };
    const routes = [ROUTES[0], ROUTES[1], reverse];
    const { props, rerender } = renderList({ routes, selectedId: 'LIM|CUZ' });
    const list = screen.getByRole('list', { name: 'Watched routes' });
    const outward = rowFor('LIM', 'CUZ');

    expect(list.querySelectorAll('li')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: /CUZ\s+to\s+LIM/ })).not.toBeInTheDocument();
    const outwardMonths = screen.getByRole('group', { name: 'Months watched for LIM → CUZ' });
    expect(within(outwardMonths).getByRole('button', { name: 'October 2026' })).toBeEnabled();
    const reverseMonth = within(outwardMonths).getByRole('button', {
      name: 'November 2026 — CUZ → LIM only',
    });
    expect(reverseMonth).toBeDisabled();
    fireEvent.click(reverseMonth);
    expect(props.onOpenMonth).not.toHaveBeenCalled();

    fireEvent.click(outward);
    expect(props.onSelect).toHaveBeenCalledWith('CUZ|LIM');
    rerender(<RouteList {...props} selectedId="CUZ|LIM" activeMonth="2026-11" />);
    expect(rowFor('CUZ', 'LIM')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /LIM\s+to\s+CUZ/ })).not.toBeInTheDocument();
    const inwardMonths = screen.getByRole('group', { name: 'Months watched for CUZ → LIM' });
    expect(within(inwardMonths).getByRole('button', { name: 'November 2026' })).toBeEnabled();
    expect(
      within(inwardMonths).getByRole('button', { name: 'October 2026 — LIM → CUZ only' }),
    ).toBeDisabled();
    fireEvent.click(within(inwardMonths).getByRole('button', { name: 'November 2026' }));
    expect(props.onOpenMonth).toHaveBeenCalledWith('CUZ|LIM', '2026-11');
    fireEvent.click(screen.getByRole('button', { name: 'Fetch CUZ → LIM now, November 2026' }));
    expect(props.onCollect).toHaveBeenCalledWith(reverse, '2026-11');
    fireEvent.click(screen.getByRole('button', { name: 'Stop watching CUZ → LIM' }));
    expect(props.onRemove).toHaveBeenCalledWith('CUZ|LIM');
    fireEvent.click(rowFor('CUZ', 'LIM'));
    expect(props.onSelect).toHaveBeenLastCalledWith('LIM|CUZ');
  });

  it('keeps shared months clickable in either direction but uses that direction as the target', () => {
    const reverse: FareRoute = {
      origin: 'CUZ',
      destination: 'LIM',
      months: ['2026-10', '2026-11'],
      currency: 'USD',
    };
    const routes = [{ ...ROUTES[0], months: ['2026-10', '2026-12'] }, reverse];
    const { props, rerender } = renderList({ routes, selectedId: 'LIM|CUZ' });
    let months = screen.getByRole('group', { name: 'Months watched for LIM → CUZ' });
    expect(within(months).getByRole('button', { name: 'October 2026' })).toBeEnabled();
    expect(within(months).getByRole('button', { name: 'December 2026' })).toBeEnabled();
    expect(
      within(months).getByRole('button', { name: 'November 2026 — CUZ → LIM only' }),
    ).toBeDisabled();
    fireEvent.keyDown(months, { key: 'ArrowRight' });
    expect(props.onOpenMonth).toHaveBeenCalledWith('LIM|CUZ', '2026-12');

    fireEvent.click(within(months).getByRole('button', { name: 'October 2026' }));
    expect(props.onOpenMonth).toHaveBeenCalledWith('LIM|CUZ', '2026-10');
    fireEvent.click(rowFor('LIM', 'CUZ'));
    expect(props.onSelect).toHaveBeenCalledWith('CUZ|LIM');
    rerender(<RouteList {...props} selectedId="CUZ|LIM" />);
    months = screen.getByRole('group', { name: 'Months watched for CUZ → LIM' });
    expect(within(months).getByRole('button', { name: 'October 2026' })).toBeEnabled();
    expect(within(months).getByRole('button', { name: 'November 2026' })).toBeEnabled();
    expect(
      within(months).getByRole('button', { name: 'December 2026 — LIM → CUZ only' }),
    ).toBeDisabled();
    fireEvent.click(within(months).getByRole('button', { name: 'October 2026' }));
    expect(props.onOpenMonth).toHaveBeenLastCalledWith('CUZ|LIM', '2026-10');
  });

  it('draws the watched months as their own controls beside the pair', () => {
    /*
     * The months left the row's own button, and they had to: a `<button>` may
     * not contain buttons, and they are controls now rather than a caption —
     * pressing one opens that month on the chart. So the row's press shrinks to
     * the swatch and the pair, and what compensates is that a press on any
     * month opens the row too.
     *
     * Named rather than numbered — 12.114 — so a month cannot be read as a day.
     * The cell prints `Oct`; the accessible name carries the year.
     */
    renderList({ routes: [ROUTES[0]] });
    const months = screen.getByRole('group', { name: 'Months watched for LIM → CUZ' });
    const tab = within(months).getByRole('button', { name: 'October 2026' });
    expect(tab).toHaveTextContent('Oct');
    // It names what it moves, rather than leaving the reader to find out.
    expect(tab).toHaveAttribute('aria-controls', 'airfare-analysis');
  });

  it('draws one control per watched month, all of them, however many', () => {
    /*
     * It used to draw three and count the rest, which made the *shape* of a
     * watch legible and its contents not: a reader could see that a route had
     * more months than fitted and had to open the editor to find out which.
     * Nine months is nine controls over three lines, and only that row is
     * taller for it.
     */
    const nine = [
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
      '2027-04',
      '2027-05',
      '2027-06',
    ];
    renderList({ routes: [{ ...ROUTES[0], months: nine }] });
    const months = screen.getByRole('group', { name: 'Months watched for LIM → CUZ' });
    expect(within(months).getAllByRole('button')).toHaveLength(9);
    // And nothing counts what it left out, because it left nothing out.
    expect(within(months).queryByText(/^\+\d/)).not.toBeInTheDocument();
  });

  it('carries the year in the accessible name and the title, never on the tab', () => {
    /*
     * The trade-off four-to-a-line buys. `Nov 26` is 55.52px against `Nov`'s
     * 31.76, so four tabs with years want 231px of a row that has 135 — the two
     * Novembers read alike here and read apart one press away, in the editor's
     * per-year strip, and out loud at all times.
     */
    renderList({ routes: [{ ...ROUTES[0], months: ['2026-11', '2027-11'] }] });
    const months = screen.getByRole('group', { name: 'Months watched for LIM → CUZ' });
    expect(within(months).getByRole('button', { name: 'November 2026' })).toHaveTextContent('Nov');
    expect(within(months).getByRole('button', { name: 'November 2027' })).toHaveTextContent('Nov');
    expect(months).toHaveAttribute('title', '2 months, November 2026 to November 2027');
  });

  it('puts the fields back to adding when the empty space is pressed', () => {
    /*
     * Pressing the empty space under the rows clears the editor without a
     * separate Cancel control.
     *
     * The page clears the selection and discards the draft through this
     * callback. The list does not save the draft on a background click.
     */
    const { props } = renderList({ editing: ROUTES[0] });
    fireEvent.click(screen.getByRole('list', { name: 'Watched routes' }));
    expect(props.onClearEditing).toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('shows Cancel for an unchanged route and Save changes only while its fields differ', () => {
    const { props } = renderList({ editing: ROUTES[0] });
    const form = screen.getByRole('form', { name: 'Edit the watch on LIM → CUZ' });
    const cancel = () => within(form).getByRole('button', { name: 'Cancel' });
    const save = () => within(form).getByRole('button', { name: 'Save changes' });

    expect(cancel()).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'Next departure year' }));
    expect(cancel()).toBeInTheDocument();

    fireEvent.change(within(form).getByRole('combobox', { name: 'Origin' }), {
      target: { value: 'AQP' },
    });
    expect(save()).toBeInTheDocument();
    fireEvent.change(within(form).getByRole('combobox', { name: 'Origin' }), {
      target: { value: 'LIM' },
    });
    expect(cancel()).toBeInTheDocument();

    fireEvent.change(within(form).getByRole('combobox', { name: 'Destination' }), {
      target: { value: 'MAD' },
    });
    expect(save()).toBeInTheDocument();
    fireEvent.change(within(form).getByRole('combobox', { name: 'Destination' }), {
      target: { value: 'CUZ' },
    });
    expect(cancel()).toBeInTheDocument();

    fireEvent.click(within(form).getByRole('button', { name: 'Previous departure year' }));
    fireEvent.click(within(form).getByRole('button', { name: 'October 2026' }));
    expect(save()).toBeInTheDocument();
    fireEvent.click(within(form).getByRole('button', { name: 'October 2026' }));
    expect(cancel()).toBeInTheDocument();

    fireEvent.click(cancel());
    expect(props.onClearEditing).toHaveBeenCalledOnce();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it('discards unsaved month edits on route change or deselection and saves only on submit', () => {
    const { props, rerender } = renderList({ editing: ROUTES[0] });
    const form = screen.getByRole('form', { name: 'Edit the watch on LIM → CUZ' });
    const october = within(form).getByRole('button', { name: 'October 2026' });
    fireEvent.click(october);
    expect(october).toHaveAttribute('aria-pressed', 'false');
    expect(props.onSave).not.toHaveBeenCalled();

    rerender(<RouteList {...props} editing={ROUTES[1]} />);
    rerender(<RouteList {...props} editing={ROUTES[0]} />);
    expect(
      within(screen.getByRole('form', { name: 'Edit the watch on LIM → CUZ' })).getByRole(
        'button',
        { name: 'October 2026' },
      ),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(
      within(screen.getByRole('form', { name: 'Edit the watch on LIM → CUZ' })).getByRole(
        'button',
        { name: 'October 2026' },
      ),
    );
    rerender(<RouteList {...props} editing={null} selectedId={null} />);
    rerender(<RouteList {...props} editing={ROUTES[0]} />);
    expect(
      within(screen.getByRole('form', { name: 'Edit the watch on LIM → CUZ' })).getByRole(
        'button',
        { name: 'October 2026' },
      ),
    ).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(
      within(screen.getByRole('form', { name: 'Edit the watch on LIM → CUZ' })).getByRole(
        'button',
        { name: 'November 2026' },
      ),
    );
    expect(props.onSave).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(props.onSave).toHaveBeenCalledWith('LIM|CUZ', {
      ...ROUTES[0],
      months: ['2026-10', '2026-11'],
    });
  });

  it('does not clear the fields on the way to selecting a route', () => {
    /*
     * The guard, and the reason it is `target === currentTarget` rather than
     * anything looser: every press inside a row bubbles through the same
     * handler, so a `closest('li')` test would clear the editor on its way to
     * opening the row the reader had just chosen.
     */
    const { props } = renderList();
    fireEvent.click(rowFor('LIM', 'CUZ'));
    expect(props.onSelect).toHaveBeenCalledWith('LIM|CUZ');
    expect(props.onClearEditing).not.toHaveBeenCalled();

    const months = screen.getByRole('group', { name: 'Months watched for LIM → CUZ' });
    fireEvent.click(within(months).getByRole('button', { name: 'October 2026' }));
    expect(props.onClearEditing).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop watching LIM → CUZ' }));
    expect(props.onClearEditing).not.toHaveBeenCalled();
  });

  it('opens a month and its route in one press', () => {
    // One callback rather than two, because a press means both — and a page
    // told twice could end up selected on one route and reading another's month.
    const { props } = renderList({ routes: [ROUTES[0]] });
    const months = screen.getByRole('group', { name: 'Months watched for LIM → CUZ' });
    fireEvent.click(within(months).getByRole('button', { name: 'October 2026' }));
    expect(props.onOpenMonth).toHaveBeenCalledWith('LIM|CUZ', '2026-10');
  });

  it('marks the open month as current, and only on the open row', () => {
    /*
     * Two levels of "current" in one row: the row says which pair the page is
     * reading, the control says which month of it the chart is drawing. A
     * control on a row nobody has opened claims neither.
     */
    renderList({ selectedId: 'LIM|CUZ', activeMonth: '2026-10' });
    const mine = screen.getByRole('group', { name: 'Months watched for LIM → CUZ' });
    expect(within(mine).getByRole('button', { name: 'October 2026' })).toHaveAttribute(
      'aria-current',
      'true',
    );

    const other = screen.getByRole('group', { name: 'Months watched for LIM → SCL' });
    expect(within(other).getByRole('button', { name: /2026/ })).not.toHaveAttribute('aria-current');
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

  it('gives the rows a box of their own, with the fields outside it', () => {
    /*
     * 12.269, and what jsdom can genuinely see of it. Whether the box actually
     * scrolls turns on `contain: size` and a shared grid row, neither of which
     * jsdom implements — `routesScroll.test.ts` reads the stylesheets for that
     * half. What is checkable here is the structure the CSS needs: a scroll
     * container holding only the rows, with the way to add a route standing
     * outside it, so a watchlist long enough to scroll does not carry away the
     * fields that add to it.
     *
     * Rendered with forty routes rather than the two the other tests use,
     * because a list that fits is a list that would pass this whatever the
     * markup did.
     */
    const many = Array.from({ length: 40 }, (_, index) => ({
      origin: 'LIM',
      destination: `X${String(index).padStart(2, '0')}`,
      months: ['2026-10'],
      currency: 'USD',
    }));
    renderList({ routes: many });

    const rows = screen.getByRole('list', { name: 'Watched routes' });
    expect(rows.querySelectorAll('li')).toHaveLength(20);
    const form = screen.getByRole('form', { name: /add a route/i });
    expect(rows.contains(form)).toBe(false);
  });

  it('lets a keyboard reach the rows box itself, not only the buttons inside it', () => {
    // The rows hold buttons, so Tab does walk in and the browser scrolls to
    // follow — but that is the only way in, and a reader who is reading rather
    // than operating has none. A tab stop on the scroller gives them the arrow
    // keys; the name is what that stop announces.
    renderList();
    const rows = screen.getByRole('list', { name: 'Watched routes' });
    expect(rows).toHaveAttribute('tabindex', '0');
  });

  it('marks neither edge while every row fits, so nothing claims rows there are not', () => {
    /*
     * jsdom reports every box as zero, which is exactly the "nothing
     * overflows" case — `listEdge` answers `none` and the marks stay off. The
     * states it cannot reach belong to `listEdge`'s own suite, which is why
     * the rule is three numbers in a function rather than arithmetic inline.
     */
    const { container } = renderList();
    const box = container.querySelector('[data-edge]');
    expect(box).not.toBeNull();
    expect(box).toHaveAttribute('data-edge', 'none');
  });

  it('keeps the fields on screen rather than behind a control', () => {
    // Adding a route is what this panel is for. A form that has to be opened
    // first puts a step in front of the only action here.
    renderList();
    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Origin')).toHaveValue('');
    expect(screen.getByLabelText('Destination')).toHaveValue('');
    expect(screen.getByLabelText('Origin')).not.toHaveAttribute('placeholder');
    expect(screen.getByLabelText('Destination')).not.toHaveAttribute('placeholder');
    expect(screen.getByRole('group', { name: 'Departing' })).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Departure year' })).not.toBeInTheDocument();
    expect(
      within(screen.getByRole('form', { name: /add a route/i })).getByText('2026'),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('form', { name: /add a route/i })).getByRole('button', {
        name: 'Add route',
      }),
    ).toBeInTheDocument();
  });

  it('moves through only the departure years offered by the collection horizon', async () => {
    const user = userEvent.setup();
    renderList();
    const form = screen.getByRole('form', { name: /add a route/i });
    const previous = within(form).getByRole('button', { name: 'Previous departure year' });
    const next = within(form).getByRole('button', { name: 'Next departure year' });

    expect(previous).toBeDisabled();
    expect(next).toBeEnabled();
    await user.click(next);
    expect(within(form).getByText('2027')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'January 2027' })).toBeInTheDocument();
    expect(previous).toBeEnabled();
    expect(next).toBeDisabled();
    await user.click(previous);
    expect(within(form).getByText('2026')).toBeInTheDocument();
  });

  it('disables both year arrows when the horizon stays in one calendar year', () => {
    renderList({ today: '2026-01-10' });
    const form = screen.getByRole('form', { name: /add a route/i });
    expect(within(form).getByText('2026')).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: 'Previous departure year' })).toBeDisabled();
    expect(within(form).getByRole('button', { name: 'Next departure year' })).toBeDisabled();
  });

  it('keeps selected months while moving between years', async () => {
    const user = userEvent.setup();
    renderList();
    const form = screen.getByRole('form', { name: /add a route/i });
    await user.click(within(form).getByRole('button', { name: 'December 2026' }));
    await user.click(within(form).getByRole('button', { name: 'Next departure year' }));
    expect(within(form).queryByText(/more in \d{2}/i)).not.toBeInTheDocument();
    await user.click(within(form).getByRole('button', { name: 'January 2027' }));
    await user.click(within(form).getByRole('button', { name: 'Previous departure year' }));
    expect(within(form).getByRole('button', { name: 'December 2026' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await user.click(within(form).getByRole('button', { name: 'Next departure year' }));
    expect(within(form).getByRole('button', { name: 'January 2027' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('adds a route from the fields', async () => {
    const user = userEvent.setup();
    const { props } = renderList();

    const strip = screen.getByRole('group', { name: 'Departing' });
    expect(within(strip).queryAllByRole('button', { pressed: true })).toHaveLength(0);

    await user.type(screen.getByLabelText('Origin'), 'LIM');
    await user.type(screen.getByLabelText('Destination'), 'MAD');
    await user.click(within(strip).getByRole('button', { name: 'December 2026' }));
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(within(strip).queryAllByRole('button', { pressed: true })).toHaveLength(0);

    // A city pair and its months, which is the whole of what a watch is. The
    // year is left on its default, which today is this one.
    expect(props.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: 'LIM',
        destination: 'MAD',
        months: ['2026-12'],
      }),
    );
  });

  it('lets a route be dragged to another position', () => {
    // Order is not decoration on this list: the collector spends its daily
    // request budget down it, so dragging to the top is a statement about
    // which route matters when the budget will not cover everything.
    const { props } = renderList();
    const rows = [
      rowFor('LIM', 'CUZ').closest('[draggable]')!,
      rowFor('LIM', 'SCL').closest('[draggable]')!,
    ];

    fireEvent.dragStart(rows[1]);
    fireEvent.drop(rows[0]);

    expect(props.onMove).toHaveBeenCalledWith('LIM|SCL', 'LIM|CUZ');
  });

  it('reorders from the keyboard too', async () => {
    // Neither list this mechanism came from could be reordered without a
    // mouse. That is fixed in the shared hook, and asserted where it is used.
    const user = userEvent.setup();
    const { props } = renderList();

    // The label is a span; the focusable thing is the row's own button.
    rowFor('LIM', 'SCL').focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');

    expect(props.onMove).toHaveBeenCalledWith('LIM|SCL', 'LIM|CUZ');
  });

  it('fetches the month the open row is reading, and names it', () => {
    /*
     * `a-press-collects-the-month-on-screen`. The press sent every month of the
     * watch, which is the button doing more than the reader can see it do — the
     * row shows one month at a time and the control sits inside it.
     */
    const { props } = renderList({
      routes: [{ ...ROUTES[0], months: ['2026-10', '2026-12'] }],
      selectedId: 'LIM|CUZ',
      activeMonth: '2026-12',
    });

    fireEvent.click(screen.getByRole('button', { name: /^Fetch LIM → CUZ now/ }));
    expect(props.onCollect).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'LIM', destination: 'CUZ' }),
      '2026-12',
    );
    expect(
      screen.getByRole('button', { name: 'Fetch LIM → CUZ now, December 2026' }),
    ).toBeInTheDocument();
  });

  it('fetches the month a row would open on where that row is not the open one', () => {
    /*
     * The tab strip marks a current month only on the open row, so an unopened
     * row has no "selected" month to collect. It fetches the one it would open
     * on — the earliest that has not departed — rather than `months[0]`, which
     * on a watch a few months old is a dead month whose series has stopped.
     *
     * And it does not select the row on the way: a collect control that also
     * moved the chart would be doing two things.
     */
    const { props } = renderList({
      routes: [{ ...ROUTES[0], months: ['2020-01', '2026-10', '2026-12'] }],
      selectedId: null,
      activeMonth: null,
    });

    fireEvent.click(screen.getByRole('button', { name: /^Fetch LIM → CUZ now/ }));
    expect(props.onCollect).toHaveBeenCalledWith(expect.anything(), '2026-10');
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('pairs consecutive routes with one action area targeting the selected route', () => {
    const { props, rerender } = renderList();
    const list = screen.getByRole('list', { name: 'Watched routes' });
    expect(list.querySelectorAll('li')).toHaveLength(1);
    expect(within(list.querySelector('li')!).getAllByRole('group')).toHaveLength(2);
    expect(
      screen.getByRole('button', {
        name: 'Fetch LIM → CUZ now, October 2026',
      }),
    ).toBeInTheDocument();

    rerender(<RouteList {...props} selectedId="LIM|SCL" />);
    expect(screen.queryByRole('button', { name: /^Fetch LIM → SCL/ })).not.toBeInTheDocument();
    const remove = screen.getByRole('button', { name: 'Stop watching LIM → SCL' });
    expect(remove.querySelector('svg[aria-hidden="true"]')).not.toBeNull();
    expect(remove).toHaveTextContent('');
    fireEvent.click(remove);
    expect(props.onRemove).toHaveBeenCalledWith('LIM|SCL');
  });

  it('keeps the odd final route and its actions', () => {
    const third: FareRoute = {
      origin: 'LIM',
      destination: 'MAD',
      months: ['2026-12'],
      currency: 'USD',
    };
    const { props, rerender } = renderList({ routes: [...ROUTES, third] });
    expect(
      screen.getByRole('list', { name: 'Watched routes' }).querySelectorAll('li'),
    ).toHaveLength(2);
    rerender(<RouteList {...props} selectedId="LIM|MAD" />);
    fireEvent.click(
      screen.getByRole('button', {
        name: 'Fetch LIM → MAD now, December 2026',
      }),
    );
    expect(props.onCollect).toHaveBeenCalledWith(third, '2026-12');
  });

  it('shows download and sync percentage in the button for one route-month only', () => {
    const route = { ...ROUTES[0], months: ['2026-10', '2026-12'] };
    const key = 'LIM|CUZ|2026-10';
    const { props, rerender } = renderList({
      routes: [route],
      selectedId: 'LIM|CUZ',
      activeMonth: '2026-10',
      collecting: [key],
      progress: new Map([[key, { stage: 'collecting', completed: 4, total: 31 }]]),
    });
    const busy = screen.getByRole('button', {
      name: 'Fetching LIM → CUZ, October 2026, downloading 12%',
    });
    expect(busy).toBeDisabled();
    expect(busy).toHaveTextContent('↓ 12%');
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();

    rerender(<RouteList {...props} activeMonth="2026-12" />);
    expect(
      screen.getByRole('button', {
        name: 'Fetch LIM → CUZ now, December 2026',
      }),
    ).toBeEnabled();

    rerender(
      <RouteList
        {...props}
        progress={new Map([[key, { stage: 'syncing', completed: 1, total: 4 }]])}
      />,
    );
    expect(
      screen.getByRole('button', {
        name: 'Fetching LIM → CUZ, October 2026, syncing 25%',
      }),
    ).toHaveTextContent('↑ 25%');
  });

  it('names each phase before its denominator is known', () => {
    const key = 'LIM|CUZ|2026-10';
    const { rerender, props } = renderList({
      routes: [ROUTES[0]],
      selectedId: 'LIM|CUZ',
      activeMonth: '2026-10',
      collecting: [key],
      progress: new Map([[key, { stage: 'submitting', completed: 0, total: null }]]),
    });
    expect(
      screen.getByRole('button', {
        name: 'Fetching LIM → CUZ, October 2026, submitting',
      }),
    ).toHaveTextContent('Sending');

    rerender(
      <RouteList
        {...props}
        progress={new Map([[key, { stage: 'queued', completed: 0, total: null }]])}
      />,
    );
    expect(
      screen.getByRole('button', {
        name: 'Fetching LIM → CUZ, October 2026, queued',
      }),
    ).toHaveTextContent('Queued');

    rerender(
      <RouteList
        {...props}
        progress={new Map([[key, { stage: 'collecting', completed: 0, total: null }]])}
      />,
    );
    expect(
      screen.getByRole('button', {
        name: 'Fetching LIM → CUZ, October 2026, downloading, preparing',
      }),
    ).toHaveTextContent('↓ Preparing');

    rerender(
      <RouteList
        {...props}
        progress={new Map([[key, { stage: 'syncing', completed: 0, total: null }]])}
      />,
    );
    expect(
      screen.getByRole('button', {
        name: 'Fetching LIM → CUZ, October 2026, syncing, preparing',
      }),
    ).toHaveTextContent('↑ Preparing');
  });

  it('does not render inline terminal report text', () => {
    renderList();
    expect(document.querySelector('[aria-live]')).toBeNull();
  });
  it('still offers the fields when nothing is watched yet', () => {
    renderList({ routes: [] });
    expect(screen.getByText(/no routes watched yet/i)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
  });
});
