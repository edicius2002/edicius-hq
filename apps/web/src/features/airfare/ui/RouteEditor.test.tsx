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

/**
 * Submit the way a browser without `type="date"` would.
 *
 * `min` and `max` on the control are one of the two guards, and pressing the
 * button only ever exercises that one — jsdom implements interactive
 * constraint validation, so a value outside the bounds never reaches `submit`
 * and the form has no chance to speak. Dispatching the event directly is what
 * a text-box fallback does: no constraints, straight into the handler. That is
 * the guard these tests are about, and the only way to see it work.
 */
function submitPastTheBrowser() {
  fireEvent.submit(screen.getByRole('form', { name: /add a route to watch/i }));
}

async function suggestionsFor(label: RegExp, typed: string) {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  const field = screen.getByRole('combobox', { name: label });
  await user.clear(field);
  await user.type(field, typed);
  return field;
}

describe('RouteEditor', () => {
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

  it('asks for one exact departure date rather than a month and a day', () => {
    // 12.180, superseding the pair 12.130 shipped. The reader has an answer to
    // "which day are you flying"; they do not have a separate answer to "which
    // month", and asking twice is how the two came to be able to disagree.
    renderEditor();
    expect(screen.getByLabelText(/departure date/i)).toHaveAttribute('type', 'date');
    expect(screen.queryByLabelText(/departure month/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^day/i)).not.toBeInTheDocument();
  });

  it('derives the watched month from the date and sends the date as the focus', async () => {
    // The month is still the whole of what gets collected — all thirty-one of
    // its departures. The date says which one the reader means to take.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.type(screen.getByLabelText(/departure date/i), '2026-11-09');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith({
      origin: 'LIM',
      destination: 'MAD',
      month: '2026-11',
      focusDate: '2026-11-09',
      currency: 'USD',
    });
  });

  it('cannot hand over a month and a focus that disagree, whatever is typed', async () => {
    /*
     * What the two-control arrangement had to guard against, and could only
     * guard against: a day left standing when the month moved out from under
     * it, invisible on screen because `type="date"` renders `09/11/2026` the
     * same way whichever month sits above it. There is no second control to
     * fall out of step with now — the month is a function of the date, taken
     * from the value being submitted — so this asserts the property rather
     * than the guard that used to defend it. Typed across three months in a
     * row, which is exactly the sequence that used to strand a day.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();
    const date = screen.getByLabelText(/departure date/i);

    for (const typed of ['2026-11-09', '2026-12-09', '2027-01-31']) {
      // Retyped each time: a successful add clears the fields behind it, which
      // is the state the stranded day used to survive.
      await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
      await user.clear(date);
      await user.type(date, typed);
      await user.click(screen.getByRole('button', { name: /add route/i }));
    }

    for (const [route] of onAdd.mock.calls) {
      expect(route.focusDate?.slice(0, 7)).toBe(route.month);
    }
    expect(onAdd.mock.calls.map(([route]) => route.month)).toEqual([
      '2026-11',
      '2026-12',
      '2027-01',
    ]);
  });

  it('bounds the picker at today and at the far end of what can be collected', () => {
    /*
     * Both ends are on the control, so the picker will not offer a day the
     * collector could never do anything with. 330 days past 2026-08-18 is
     * 2027-07-14 — the horizon the API measured, copied to the web side so the
     * refusal happens in front of the reader rather than in a skip list.
     */
    renderEditor();
    const date = screen.getByLabelText(/departure date/i);
    expect(date).toHaveAttribute('min', '2026-08-18');
    expect(date).toHaveAttribute('max', '2027-07-14');
  });

  it('says a day has gone rather than adding a departure nothing can collect', async () => {
    // A day behind today would be refused by the collector on every pass
    // forever, and nothing on the page would tell the reader it was the day.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.type(screen.getByLabelText(/departure date/i), '2026-08-03');
    submitPastTheBrowser();

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('That day has gone.');
  });

  it('refuses a date past the horizon in words instead of dropping it later', async () => {
    /*
     * The other half of the same argument, and the half the form did not make
     * before: a month past the horizon was accepted, and every one of its
     * departures came back `beyond-horizon` on every pass with nothing on
     * screen connecting that to the date that had been typed. The reason names
     * the last day that works, because "too far" without a number leaves the
     * reader guessing at a bound they cannot see.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.type(screen.getByLabelText(/departure date/i), '2027-08-01');
    submitPastTheBrowser();

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('14/07/2027');
  });

  it('has no return field at all, rather than one that is ignored', () => {
    // 12.113: a month of departures has no single return date to share, and a
    // control the collector would silently drop is worse than no control.
    renderEditor();
    expect(screen.queryByLabelText(/return/i)).not.toBeInTheDocument();
  });

  it('asks for the day in its own voice rather than the browser bubble', async () => {
    /*
     * The date is required and there is no `required` attribute saying so. A
     * native constraint would stop the submit event firing, answer in the
     * browser's own bubble, and pre-empt the airport checks that come first —
     * making this the one refusal in the form that arrives somewhere else.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(screen.getByLabelText(/departure date/i)).not.toHaveAttribute('required');
    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Pick the day you mean to fly.');
  });

  it('says which field is wrong rather than letting the route vanish', async () => {
    // A route that disappears on save looks like a broken button, and the
    // reader has no way to learn which field was the problem. The airports are
    // checked before the date, so an empty form complains about them first.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByLabelText(/departure date/i), '2026-11-09');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Origin and destination must be three-letter IATA codes.',
    );
  });
});
