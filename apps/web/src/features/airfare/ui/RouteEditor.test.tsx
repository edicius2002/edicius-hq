import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
import { ADD_ROUTE_FORM_ID, RouteEditor } from '@/features/airfare/ui/RouteEditor';

// Compiled for real rather than proxied — see `vite.config`'s allowlist. The
// strip's track count decides its height, and jsdom lays out neither.
import editorStyles from './RouteEditor.module.css?inline';

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
        <RouteEditor
          today="2026-08-18"
          editing={null}
          watched={[]}
          onAdd={onAdd}
          onSave={vi.fn()}
        />
        <button type="submit" form={ADD_ROUTE_FORM_ID}>
          Add route
        </button>
      </>,
    ),
    onAdd,
  };
}

/** The year control, by the name a screen reader hears it under. */
function year() {
  return screen.getByRole('combobox', { name: 'Departure year' });
}

/**
 * The twelve cells of the strip, in calendar order.
 *
 * Found by their group rather than by role alone, because the form holds other
 * buttons and a screen full of `getAllByRole('button')` would drift the moment
 * one is added.
 */
function monthChips(): HTMLElement[] {
  const strip = screen.getByRole('group', { name: 'Departing' });
  return within(strip).getAllByRole('button');
}

/** One cell, by its accessible name — `September 2026`. */
function chip(name: string): HTMLElement {
  return within(screen.getByRole('group', { name: 'Departing' })).getByRole('button', { name });
}

/** Which months are picked, in calendar order, by name. */
function pressedMonths(): (string | null)[] {
  return monthChips()
    .filter((cell) => cell.getAttribute('aria-pressed') === 'true')
    .map((cell) => cell.getAttribute('aria-label'));
}

/**
 * The strip's own track declaration, read out of the compiled stylesheet.
 *
 * jsdom lays nothing out, so six-across-and-two-down is unobservable from the
 * rendered tree — the same reason `moneyWeekGrid.test` reads its stylesheet.
 * `RouteEditor.module.css` is on `vite.config`'s compile allowlist for this.
 */
function monthStripRule(): string {
  // Comments are stripped first, because the prose above these rules names
  // the classes and would otherwise be matched as one of them. The class name
  // itself is hashed by the CSS module, so it is matched by its stem.
  const sheet = editorStyles.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /\.[_A-Za-z0-9-]*months[_A-Za-z0-9-]*\s*\{([^}]*)\}/.exec(sheet);
  if (!rule) throw new Error('no `.months` rule in the compiled stylesheet');
  return rule[1];
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
    expect(row?.contains(screen.getByRole('group', { name: 'Departing' }))).toBe(false);
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

  it('asks for months as twelve chips rather than for an exact date', () => {
    /*
     * 12.262 took the date control away and asked for a month and a year;
     * `a-watch-is-a-pair-and-its-months` takes the month dropdown away too. A
     * watch holds several months, and a control that names one at a time can
     * neither show which months are watched nor let the reader change their
     * mind about one of them.
     */
    renderEditor();
    expect(screen.queryByLabelText(/departure date/i)).not.toBeInTheDocument();
    expect(document.querySelector('input[type="date"]')).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Departure month' })).not.toBeInTheDocument();

    // Twelve toggles, and the year control still beside them: the horizon
    // reaches into a second calendar year and twelve chips cover one.
    expect(monthChips()).toHaveLength(12);
    expect(year().tagName).toBe('SELECT');
  });

  it('draws the twelve as six across and two down', () => {
    // Six per row so a row is half a year, which costs one row of height less
    // than the four-by-three a calendar year suggests — and this form is
    // spending the panel's height budget. Asserted on the declaration rather
    // than on geometry, because jsdom lays nothing out.
    renderEditor();
    expect(monthStripRule()).toMatch(/repeat\(6,\s*minmax\(0,\s*1fr\)\)/);
  });

  it('names each chip with its year, because the year lives in another control', () => {
    // 12.114's rule reaching the control that produces the value: `September`
    // rather than `09`. The visible text is short enough for a six-track row,
    // so the year rides in the accessible name where it cannot be lost.
    renderEditor();
    expect(monthChips().map((chip) => chip.getAttribute('aria-label'))).toEqual([
      'January 2026',
      'February 2026',
      'March 2026',
      'April 2026',
      'May 2026',
      'June 2026',
      'July 2026',
      'August 2026',
      'September 2026',
      'October 2026',
      'November 2026',
      'December 2026',
    ]);
    expect(monthChips().map((chip) => chip.textContent)).toEqual([
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]);
  });

  it('opens on next month, which is not the month the reader is standing in', () => {
    // Today is 2026-08-18, so the default is September 2026: the near days of
    // August have gone and its far ones barely move. And it is the *only* one
    // pressed — a form that opened with several picked would be choosing for
    // the reader.
    renderEditor();
    expect(pressedMonths()).toEqual(['September 2026']);
  });

  it('rolls the year with the month when next month is in the next one', () => {
    /*
     * The one default that can be wrong quietly. From 15 December the next
     * month is January **2027**, and a strip that opened on January while the
     * year stayed on 26 would put the reader eleven months in the past with
     * both controls looking perfectly ordinary.
     */
    render(
      <RouteEditor
        today="2026-12-15"
        editing={null}
        watched={[]}
        onAdd={vi.fn()}
        onSave={vi.fn()}
      />,
    );
    expect(pressedMonths()).toEqual(['January 2027']);
    expect(year()).toHaveValue('2027');
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
    const options = within(year()).getAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['26', '27']);
    // The stored value is the whole year — a two-digit value would be a
    // century nobody stated.
    expect(options.map((option) => option.getAttribute('value'))).toEqual(['2026', '2027']);
  });

  it('hands over the months that are pressed, as a list, and no day', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.click(chip('September 2026'));
    await user.click(chip('November 2026'));
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith({
      origin: 'LIM',
      destination: 'MAD',
      months: ['2026-11'],
      currency: 'USD',
    });
    // Checked on the keys as well: a `month: undefined` would pass the
    // assertion above and still reach the stored document as a dead key.
    expect(Object.keys(onAdd.mock.calls[0][0])).toEqual([
      'origin',
      'destination',
      'months',
      'currency',
    ]);
  });

  it('takes several months in one press of the button', async () => {
    // The whole point of the change: three months of one pair used to be three
    // visits to this form and three rows in the list.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.click(chip('October 2026'));
    await user.click(chip('December 2026'));
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ months: ['2026-09', '2026-10', '2026-12'] }),
    );
  });

  it('un-presses a month that was pressed', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    await user.click(chip('October 2026'));
    expect(pressedMonths()).toEqual(['September 2026', 'October 2026']);

    await user.click(chip('October 2026'));
    expect(pressedMonths()).toEqual(['September 2026']);
  });

  it('says how many picked months are in the year the strip is not showing', async () => {
    /*
     * The strip is one calendar year and the selection is not. Without this a
     * reader on 26 who has picked March 2027 sees twelve unpressed chips and a
     * form that looks empty.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    fireEvent.change(year(), { target: { value: '2027' } });
    await user.click(chip('March 2027'));
    expect(screen.getByText('1 more in 26')).toBeInTheDocument();

    fireEvent.change(year(), { target: { value: '2026' } });
    expect(screen.getByText('1 more in 27')).toBeInTheDocument();
    // And the month in the other year survives the trip.
    expect(pressedMonths()).toEqual(['September 2026']);
  });

  it('carries a selection across two years through to the add', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    fireEvent.change(year(), { target: { value: '2027' } });
    await user.click(chip('March 2027'));
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ months: ['2026-09', '2027-03'] }));
  });

  it('refuses a month that has gone at the chip, and says why on it', () => {
    /*
     * Reachable because the year list starts at this year: in August, January
     * 2026 is on the strip. Every day of it comes back `departed` on every pass
     * forever, and nothing on screen would connect that to the control.
     *
     * Disabled *and drawn*, with the reason on `title` — `IndicatorBar`'s
     * bargain. Hiding it would leave a strip that changed length as the
     * calendar moved.
     */
    renderEditor();
    expect(chip('January 2026')).toBeDisabled();
    expect(chip('January 2026')).toHaveAttribute('title', 'That month has gone.');
  });

  it('refuses a month past the horizon at the chip, naming the last day that works', () => {
    /*
     * 12.264, keeping 12.184. All twelve stay on offer in both years, so
     * August 2027 is drawn — and it is past the 14/07/2027 the provider stops
     * answering at. The message names the day rather than saying "too far",
     * because a bound the reader cannot see is a bound they have to guess at.
     *
     * Disabling a chip does **not** reintroduce what 12.264 refused. That was
     * narrowing one dropdown against another, where moving the year would have
     * to un-pick the month under the reader. A chip names a whole `YYYY-MM`:
     * moving the year draws twelve different cells and changes no value.
     */
    renderEditor();
    fireEvent.change(year(), { target: { value: '2027' } });
    expect(chip('August 2027')).toBeDisabled();
    expect(chip('August 2027').getAttribute('title')).toContain('14/07/2027');
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
    await user.click(chip('September 2026'));
    fireEvent.change(year(), { target: { value: '2027' } });
    expect(chip('July 2027')).toBeEnabled();
    await user.click(chip('July 2027'));
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith(expect.objectContaining({ months: ['2027-07'] }));
  });

  it('refuses an empty strip rather than adding a watch with no month', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.click(chip('September 2026'));
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Pick at least one departure month.');
  });

  it('keeps the strip and the year legible while it refuses', async () => {
    /*
     * What 12.185 was actually defending, restated for a control that cannot
     * be redundant. The month-and-day pair could disagree *invisibly*, because
     * `type="date"` renders `09/03/2027` identically whichever month sat above
     * it. A refused strip is one the reader can see and correct.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    fireEvent.change(year(), { target: { value: '2027' } });
    await user.click(chip('March 2027'));
    await user.click(screen.getByRole('button', { name: /add route/i }));

    // Refused for the airports, which are checked first — and nothing about
    // the departure moved while it was refused.
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(year()).toHaveValue('2027');
    expect(chip('March 2027')).toHaveAttribute('aria-pressed', 'true');
  });

  it('goes back to next month after an add, rather than staying on what was added', async () => {
    // Leaving the strip on what was just added invites a second watch on the
    // same months from a reader who only changed the destination.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.click(chip('October 2026'));
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(pressedMonths()).toEqual(['September 2026']);
  });

  it('says what the picked months will cost a pass', async () => {
    /*
     * The only feedback there is. The daily request ceiling was removed, so
     * nothing between a reader ticking a twelfth month and a pass that runs
     * for twenty minutes says anything at all — and the consequence of a long
     * pass is invisible by construction.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    // September 2026 alone: thirty days, at three seconds each.
    expect(screen.getByText(/1 month · up to 30 departures to price/)).toBeInTheDocument();

    await user.click(chip('October 2026'));
    expect(screen.getByText(/2 months · up to 61 departures to price/)).toBeInTheDocument();
  });

  it('warns when the picked months would outrun the window a pass has', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    for (const name of ['October 2026', 'November 2026', 'December 2026']) {
      await user.click(chip(name));
    }
    fireEvent.change(year(), { target: { value: '2027' } });
    for (const name of [
      'January 2027',
      'February 2027',
      'March 2027',
      'April 2027',
      'May 2027',
      'June 2027',
    ]) {
      await user.click(chip(name));
    }

    // "without a word" is the point, and it is what the scheduler actually
    // does: no error, no log, nothing that looks unlike a quiet market.
    expect(screen.getByText(/discarded without a word/)).toBeInTheDocument();
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
     * about them first. One `role="alert"`, in document order, for every reason
     * this form can refuse.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Origin and destination must be three-letter IATA codes.',
    );
  });

  it('refuses to add a pair that is already watched, and says where to go instead', async () => {
    /*
     * The transitions answer this by merging, which is the right answer to
     * give and the wrong thing to do to a reader without asking: the row they
     * were editing would disappear into another one.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const onAdd = vi.fn();
    render(
      <>
        <RouteEditor
          today="2026-08-18"
          editing={null}
          watched={['LIM|MAD']}
          onAdd={onAdd}
          onSave={vi.fn()}
        />
        <button type="submit" form={ADD_ROUTE_FORM_ID}>
          Add route
        </button>
      </>,
    );

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('LIM → MAD is already watched');
  });
});

describe('RouteEditor, with a watch loaded into it', () => {
  const WATCH: FareRoute = {
    origin: 'LIM',
    destination: 'CUZ',
    months: ['2026-09', '2026-11'],
    currency: 'USD',
  };

  function renderEditing(route: FareRoute = WATCH) {
    const onSave = vi.fn<(id: string, route: FareRoute) => void>();
    return {
      ...render(
        <>
          <RouteEditor
            today="2026-08-18"
            editing={route}
            watched={['LIM|CUZ', 'LIM|SCL']}
            onAdd={vi.fn()}
            onSave={onSave}
          />
          <button type="submit" form={ADD_ROUTE_FORM_ID}>
            Save changes
          </button>
        </>,
      ),
      onSave,
    };
  }

  it('loads the watch into the fields and presses its own months', () => {
    renderEditing();
    expect(screen.getByRole('combobox', { name: /origin/i })).toHaveValue('LIM');
    expect(screen.getByRole('combobox', { name: /destination/i })).toHaveValue('CUZ');
    expect(pressedMonths()).toEqual(['September 2026', 'November 2026']);
  });

  it('names itself for the watch it is editing', () => {
    renderEditing();
    expect(screen.getByRole('form', { name: /edit the watch on LIM → CUZ/i })).toBeInTheDocument();
  });

  it('saves the months as they now stand, under the id it was given', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSave } = renderEditing();

    await user.click(chip('November 2026'));
    await user.click(chip('December 2026'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith('LIM|CUZ', {
      origin: 'LIM',
      destination: 'CUZ',
      months: ['2026-09', '2026-12'],
      currency: 'USD',
    });
  });

  it('warns that the archive does not travel with a changed pair', async () => {
    /*
     * Stated the moment the field differs rather than after Save: afterwards
     * the chart is already blank and the reader is working out what they broke.
     * Nothing is deleted — the old pair's archive is on disk and comes back
     * whole if it is watched again — so this is a warning and not a refusal.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditing();

    await user.clear(screen.getByRole('combobox', { name: /destination/i }));
    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');

    const note = screen.getByRole('status');
    expect(note).toHaveTextContent('Saving this changes the pair to LIM → MAD');
    expect(note).toHaveTextContent('stays on disk under that pair');
  });

  it('warns that a dropped month stops collecting and keeps what it collected', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditing();

    await user.click(chip('November 2026'));

    expect(screen.getByRole('status')).toHaveTextContent(
      'Dropping November 2026 stops collecting it. Everything already collected stays on disk.',
    );
  });

  it('lets a watch whose month has gone still be edited', async () => {
    /*
     * The calendar walks past a watched month while the reader is not looking.
     * Refusing the whole save for a month they did not touch would make the
     * route uneditable forever, exactly when they came to add the next one.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const stale: FareRoute = { ...WATCH, months: ['2026-01', '2026-09'] };
    const { onSave } = renderEditing(stale);

    // The stale chip is pressed and *not* disabled: a pressed control that
    // cannot be un-pressed is a trap.
    expect(chip('January 2026')).toBeEnabled();
    expect(chip('January 2026')).toHaveAttribute('aria-pressed', 'true');

    await user.click(chip('October 2026'));
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave).toHaveBeenCalledWith(
      'LIM|CUZ',
      expect.objectContaining({ months: ['2026-01', '2026-09', '2026-10'] }),
    );
  });

  it('refuses an edit onto a pair another watch already holds', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onSave } = renderEditing();

    await user.clear(screen.getByRole('combobox', { name: /destination/i }));
    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'scl');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('LIM → SCL is already watched');
  });
});
