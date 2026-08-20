import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { ADD_ROUTE_FORM_ID, RouteEditor } from '@/features/airfare/ui/RouteEditor';

/**
 * Both ends of a route are searchable, and the destination is the one that
 * matters.
 *
 * `AirportField` has its own suite and it passes; what that suite cannot see
 * is whether the form actually wired *both* fields to it. The origin arrives
 * pre-filled with LIM and is usually left alone, so a destination that quietly
 * lost its suggestion list would look fine on every screenshot and be the only
 * field anyone ever needs it on.
 */

const AIRPORTS: Record<string, { code: string; city: string; country: string; name: string }[]> = {
  cus: [{ code: 'CUZ', city: 'Cusco', country: 'Peru', name: 'Alejandro Velasco Astete' }],
  mad: [{ code: 'MAD', city: 'Madrid', country: 'Spain', name: 'Adolfo Suárez Madrid–Barajas' }],
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.stubGlobal(
    'fetch',
    vi.fn((input: string) => {
      const query = new URL(input, 'http://localhost').searchParams.get('q') ?? '';
      return Promise.resolve(
        Response.json({ query, matches: AIRPORTS[query.toLowerCase()] ?? [] }),
      );
    }),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * The editor plus the button that submits it, which lives outside the form.
 *
 * "Add route" sits in the panel header, up beside the heading, associated by
 * the `form` attribute rather than by containment. Rendering it here is not
 * scaffolding — that association is the part of this arrangement that can
 * silently stop working.
 */
function renderEditor() {
  // Typed rather than a bare `vi.fn()`, so a test can read a field off what
  // was handed over without the route arriving as `any`.
  const onAdd = vi.fn<(route: FareRoute) => void>();
  return {
    ...render(
      <>
        <RouteEditor today="2026-08-18" onAdd={onAdd} />
        <button type="submit" form={ADD_ROUTE_FORM_ID}>
          Add route
        </button>
      </>,
    ),
    onAdd,
  };
}

/** The month and the year, by the names a screen reader hears them under. */
function departure() {
  return {
    month: screen.getByRole('combobox', { name: 'Departure month' }),
    year: screen.getByRole('combobox', { name: 'Departure year' }),
  };
}

/**
 * Pick a month and a year, in the two presses a reader makes.
 *
 * `fireEvent.change` rather than `user.selectOptions`, because the two
 * dropdowns are set independently and React batches synchronous events: each
 * one is its own state update and its own render.
 */
function pick(month: string, year: string) {
  const { month: monthField, year: yearField } = departure();
  fireEvent.change(monthField, { target: { value: month } });
  fireEvent.change(yearField, { target: { value: year } });
}

async function suggestionsFor(label: RegExp, typed: string) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const field = screen.getByRole('combobox', { name: label });
  await user.clear(field);
  await user.type(field, typed);
  return field;
}

describe('RouteEditor', () => {
  it('puts every label beside its own field rather than above it', () => {
    /*
     * 12.265. Asserted on document order rather than on geometry, because
     * jsdom has no layout — the stylesheet is what turns this into four
     * columns, and the browser check that the widest row fits the panel's
     * 20rem floor is in the commit that carries it.
     */
    renderEditor();
    const form = screen.getByRole('form', { name: /add a route to watch/i });
    const labels = [...form.querySelectorAll('label, [id="airfare-departing-label"]')].map(
      (node) => node.textContent,
    );
    expect(labels).toEqual(['Origin', 'Destination', 'Departing']);
  });

  it('keeps the two airports on one row, with the departure on the next', () => {
    /*
     * 12.268. They are one decision and they share a row, which briefly looked
     * impossible: a label beside a field costs the label's width, and two of
     * each at the old 8rem input minimum ran 500-odd pixels against the 358
     * this panel has at its floor. The 8rem was the thing that had to move —
     * it was 160px held for a three-letter code.
     *
     * Checked through the wrapper the lists also hang from, because that
     * element is what makes both true at once: it is the row, and it is the
     * positioning context an inline field hands to its caller.
     */
    renderEditor();
    const form = screen.getByRole('form', { name: /add a route to watch/i });
    const origin = screen.getByRole('combobox', { name: /origin/i });
    const destination = screen.getByRole('combobox', { name: /destination/i });

    // The smallest element holding both airports. `closest` cannot find it:
    // an inline field's own wrapper is `display: contents`, so the row is two
    // levels up rather than one.
    let row: HTMLElement | null = origin.parentElement;
    while (row && row !== form && !row.contains(destination)) row = row.parentElement;

    expect(row).not.toBe(form);
    expect(row?.contains(destination)).toBe(true);
    expect(row?.contains(screen.getByRole('combobox', { name: 'Departure month' }))).toBe(false);
  });

  it('offers both ends as a combobox, not as bare text inputs', () => {
    renderEditor();
    expect(screen.getByRole('combobox', { name: /origin/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /destination/i })).toBeInTheDocument();
  });

  it('searches from the destination field', async () => {
    renderEditor();
    await suggestionsFor(/destination/i, 'mad');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    // By option, not by text: "Madrid" is in the city *and* in the airport's
    // own name, so a bare text query matches twice.
    expect(
      within(screen.getByRole('listbox')).getByRole('option', { name: /MAD/ }),
    ).toBeInTheDocument();
  });

  it('searches from the origin field too, once it is typed in', async () => {
    // It mounts holding LIM, and a value that is simply *there* deliberately
    // does not search — otherwise a list pops open over the map on load.
    renderEditor();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();

    await suggestionsFor(/origin/i, 'cus');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    expect(
      within(screen.getByRole('listbox')).getByRole('option', { name: /Cusco/ }),
    ).toBeInTheDocument();
  });

  it('fills the field it was opened from, and only that one', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();
    await suggestionsFor(/destination/i, 'mad');
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    await user.click(within(screen.getByRole('listbox')).getByRole('option', { name: /MAD/ }));
    expect(screen.getByRole('combobox', { name: /destination/i })).toHaveValue('MAD');
    expect(screen.getByRole('combobox', { name: /origin/i })).toHaveValue('LIM');
  });

  it('opens the destination list leftwards and the origin list rightwards', async () => {
    /*
     * Told, not measured. The destination sits hard against the right edge of
     * its panel, and a list wider than its input has nowhere to go but off the
     * page — which is what puts a horizontal scrollbar on the tab. The old
     * version read the list's own rectangle *after* it had painted and moved
     * it on the next frame, so the first open always overflowed first.
     */
    renderEditor();
    // Each field's own list, found through the combobox that owns it — both
    // can be on screen at once while one is closing.
    const listFor = (label: RegExp) => {
      const id = screen.getByRole('combobox', { name: label }).getAttribute('aria-controls');
      return id ? document.getElementById(id) : null;
    };

    await suggestionsFor(/destination/i, 'mad');
    await waitFor(() => expect(listFor(/destination/i)).toBeInTheDocument());
    expect(listFor(/destination/i)?.className).toMatch(/leftwards/);

    await suggestionsFor(/origin/i, 'cus');
    await waitFor(() => expect(listFor(/origin/i)).toBeInTheDocument());
    expect(listFor(/origin/i)?.className).not.toMatch(/leftwards/);
  });

  it('asks for a month and a year rather than an exact date', () => {
    /*
     * 12.262, superseding 12.180 and the focus 12.130 built under it. The
     * reader filling this in knows they are flying in September; the date
     * control asked them for the 9th, which is a precision they do not have
     * at the moment they add the watch — and the whole page then narrowed
     * itself onto that one day.
     */
    renderEditor();
    expect(screen.queryByLabelText(/departure date/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="date"]')).toBeNull();

    const { month, year } = departure();
    expect(month.tagName).toBe('SELECT');
    expect(year.tagName).toBe('SELECT');
  });

  it('offers the twelve months by name, so none of them can be read as a day', () => {
    // 12.114's rule reaching the control that produces the value: `September`
    // rather than `09`, which sits close enough to this feature's dd/mm/yyyy
    // dates that a reader has to work out which half they are looking at.
    renderEditor();
    const names = within(departure().month)
      .getAllByRole('option')
      .map((option) => option.textContent);
    expect(names).toEqual([
      'January',
      'February',
      'March',
      'April',
      'May',
      'June',
      'July',
      'August',
      'September',
      'October',
      'November',
      'December',
    ]);
  });

  it('opens on next month, which is not the month the reader is standing in', () => {
    // Today is 2026-08-18, so the default is September 2026: the near days of
    // August have gone and its far ones barely move.
    renderEditor();
    expect(departure().month).toHaveValue('09');
    expect(departure().year).toHaveValue('2026');
  });

  it('rolls the year with the month when next month is in the next one', () => {
    /*
     * The one default that can be wrong quietly. From 15 December the next
     * month is January **2027**, and a month that rolled while its year stayed
     * behind would open the form eleven months in the past with both halves
     * looking perfectly ordinary.
     */
    render(<RouteEditor today="2026-12-15" onAdd={vi.fn()} />);
    expect(departure().month).toHaveValue('01');
    expect(departure().year).toHaveValue('2027');
  });

  it('offers the years the horizon spans, written as two digits', () => {
    /*
     * 12.263. 330 days past 2026-08-18 is 2027-07-14, so the window is
     * 2026-08..2027-07 and the list is exactly `26` and `27`. It comes from
     * `collectableYears` rather than being typed in: the same two literals
     * would be right until 2027 and silently wrong after it, in the control
     * whose job is to stop a reader naming a month nobody can collect.
     */
    renderEditor();
    const options = within(departure().year).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['26', '27']);
    // The stored value is the whole year — a two-digit value would be a
    // century nobody stated.
    expect(options.map((option) => option.getAttribute('value'))).toEqual(['2026', '2027']);
  });

  it('hands over the month the two dropdowns name between them, and no day', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    pick('11', '2026');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith({
      origin: 'LIM',
      destination: 'MAD',
      month: '2026-11',
      currency: 'USD',
    });
    // Checked on the keys as well: a `focusDate: undefined` would pass the
    // assertion above and still reach the stored document as a key.
    expect(Object.keys(onAdd.mock.calls[0][0])).toEqual([
      'origin',
      'destination',
      'month',
      'currency',
    ]);
  });

  it('goes back to next month after an add, rather than staying on what was added', async () => {
    // A dropdown has no empty state to return to, and leaving it on the month
    // just added invites a second watch on the same month from a reader who
    // only changed the destination.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    pick('01', '2027');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(departure().month).toHaveValue('09');
    expect(departure().year).toHaveValue('2026');
  });

  it('says a month has gone rather than adding one nothing can collect', async () => {
    /*
     * Reachable because the year list starts at this year: in August, January
     * 2026 is two presses away. Every day of it comes back `departed` on every
     * pass forever, and nothing on screen would connect that to the dropdowns.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    pick('01', '2026');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('That month has gone.');
  });

  it('refuses a month past the horizon by naming the last day that works', async () => {
    /*
     * 12.264, keeping 12.184. All twelve months stay on offer and both years
     * do, so August 2027 can be picked — and it is past the 14/07/2027 the
     * provider stops answering at. The alternative was narrowing one dropdown
     * against the other, which means un-picking a month when the year moves
     * under it: a control that edits itself while the reader is looking at it.
     *
     * The message names the day rather than saying "too far", because a bound
     * the reader cannot see is a bound they have to guess at.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    pick('08', '2027');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('14/07/2027');
  });

  it('takes the month the horizon lands inside, half a month being enough', async () => {
    // July 2027 holds 14 collectable departures and 17 that are not. The
    // collector polls the ones it can reach and reports the rest by name,
    // which is exactly what it already does for the days of this month that
    // have gone — so refusing the whole month would cost the reader two weeks
    // of fares for the sake of a tidier rule.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    pick('07', '2027');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ month: '2027-07' }));
  });

  it('keeps both halves of the departure legible while it refuses them', async () => {
    /*
     * What 12.185 was actually defending, restated for two controls that
     * cannot be redundant. The month-and-day pair could disagree *invisibly*,
     * because `type="date"` renders `09/03/2027` identically whichever month
     * sat above it. A month and a year state different things, state them in
     * words, and neither is derivable from the other — so a refused
     * combination is one the reader can see and correct rather than one they
     * have to be protected from.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    pick('08', '2027');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(departure().month).toHaveValue('08');
    expect(departure().year).toHaveValue('2027');
  });

  it('has no return field at all, rather than one that is ignored', () => {
    // 12.113: a month of departures has no single return date to share, and a
    // control the collector would silently drop is worse than no control.
    renderEditor();
    expect(screen.queryByLabelText(/return/i)).not.toBeInTheDocument();
  });

  it('says which field is wrong rather than letting the route vanish', async () => {
    /*
     * A route that disappears on save looks like a broken button, and the
     * reader has no way to learn which field was the problem. The airports are
     * checked before the departure, so a form with no destination complains
     * about them first — and the departure never *is* empty now, because two
     * dropdowns always name a month between them. One `role="alert"`, in
     * document order, for every reason this form can refuse.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    pick('11', '2026');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Origin and destination must be three-letter IATA codes.',
    );
  });
});
