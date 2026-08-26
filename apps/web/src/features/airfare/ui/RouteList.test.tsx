import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { routeId, type FareRoute } from '@/features/airfare/data/fareRoutes';
import type { PassProgress } from '@/features/airfare/lib/passProgress';
import type { RowReport } from '@/features/airfare/lib/rowReport';
import { ADD_ROUTE_FORM_ID } from '@/features/airfare/ui/RouteEditor';
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
    reports: new Map<string, RowReport>(),
    progress: new Map<string, PassProgress>(),
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
     * Choosing a row used to be a one-way door: the form held that watch and
     * the only way back to a blank one was the Cancel button up beside the
     * heading. Pressing the empty space under the rows is what everyone tries
     * first.
     *
     * The selection is deliberately left alone — the reader said they had
     * finished editing, not that they had finished looking at a chart.
     */
    const { props } = renderList({ editing: ROUTES[0] });
    fireEvent.click(screen.getByRole('list', { name: 'Watched routes' }));
    expect(props.onClearEditing).toHaveBeenCalled();
    expect(props.onSelect).not.toHaveBeenCalled();
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
    expect(rows.querySelectorAll('li')).toHaveLength(40);
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
    expect(screen.getByLabelText('Origin')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Departing' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Departure year' })).toBeInTheDocument();
  });

  it('adds a route from the fields', async () => {
    const user = userEvent.setup();
    const { props } = renderList();

    await user.clear(screen.getByLabelText('Origin'));
    await user.type(screen.getByLabelText('Origin'), 'LIM');
    await user.type(screen.getByLabelText('Destination'), 'MAD');
    const strip = screen.getByRole('group', { name: 'Departing' });
    // Off the month the form opens on, and on to December, so the assertion
    // below is about a press rather than about a default.
    await user.click(within(strip).getByRole('button', { name: 'September 2026' }));
    await user.click(within(strip).getByRole('button', { name: 'December 2026' }));
    await user.click(screen.getByRole('button', { name: /add route/i }));

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
    const rows = screen.getAllByRole('listitem');

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

  it('offers each row its own collection, named for the route it would collect', () => {
    // "Collect" on its own would be nine identical buttons in the
    // accessibility tree, and the mark that carries it visually says nothing
    // out loud at all.
    renderList();
    expect(
      screen.getByRole('button', { name: 'Collect LIM → CUZ now, October 2026' }),
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
      months: ['2026-12'],
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

  it('draws how far the pass has got, and only on the row running one', () => {
    const running = routeId(ROUTES[0]);
    const idle = routeId(ROUTES[1]);
    renderList({
      collecting: [running],
      progress: new Map([[running, { completed: 4, polling: 31, fraction: 4 / 31 }]]),
    });

    const bar = screen.getByTestId(`collect-progress-${running}`);
    // The fill is a width, so the figure the reader is looking at is checkable
    // as the figure the pass reported rather than as a class name.
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${(4 / 31) * 100}%`);
    // Drawn and never read aloud: the line under it is already announcing "4
    // of 31" into a live region, and a bar that entered the accessibility tree
    // would have one row saying the same figure twice.
    expect(bar).toHaveAttribute('aria-hidden', 'true');

    // A row between presses costs no element at all — a track drawn on every
    // row would be three pixels of ink down an idle watchlist.
    expect(screen.queryByTestId(`collect-progress-${idle}`)).not.toBeInTheDocument();
  });

  it('sweeps rather than sits at zero while the pass has no denominator yet', () => {
    // `polling` lands before the first upstream request but after the press
    // returns, so there is a window in which the pass is running and how long
    // it will be is unknown. A bar at zero would be claiming a length it has
    // not got.
    const running = routeId(ROUTES[0]);
    renderList({
      collecting: [running],
      progress: new Map([[running, { completed: 0, polling: null, fraction: null }]]),
    });

    const bar = screen.getByTestId(`collect-progress-${running}`);
    expect(bar.className).toMatch(/unplanned/);
    // No inline width: the stylesheet owns the sweep, and a width written here
    // would pin the fill and stop it moving.
    expect((bar.firstElementChild as HTMLElement).style.width).toBe('');
  });

  it('still offers the fields when nothing is watched yet', () => {
    renderList({ routes: [] });
    expect(screen.getByText(/no routes watched yet/i)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
  });
});
