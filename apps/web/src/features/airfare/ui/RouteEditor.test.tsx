import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const onAdd = vi.fn();
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

  it('takes the two ends and the month and hands over a route', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.type(screen.getByLabelText(/departure month/i), '2026-11');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith({
      origin: 'LIM',
      destination: 'MAD',
      month: '2026-11',
      currency: 'USD',
    });
  });

  it('offers a month to depart in rather than a day', () => {
    // 12.110: the watch is a month, and asking for a day here would be asking
    // the reader to choose the thing the page exists to work out for them.
    renderEditor();
    expect(screen.getByLabelText(/departure month/i)).toHaveAttribute('type', 'month');
  });

  it('takes an optional day inside the month and sends it as the focus', async () => {
    // 12.130. The month is still what gets collected; the day says which of
    // its departures the reader means to take, which is what the detail, the
    // chart and the table then speak about.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.type(screen.getByLabelText(/departure month/i), '2026-11');
    await user.type(screen.getByLabelText(/^day/i), '2026-11-09');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith({
      origin: 'LIM',
      destination: 'MAD',
      month: '2026-11',
      focusDate: '2026-11-09',
      currency: 'USD',
    });
  });

  it('carries no focus key at all when the day is left empty', async () => {
    // A route with no focus is the ordinary case, and a `focusDate: undefined`
    // written into the stored document would come back on the next read.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.type(screen.getByLabelText(/departure month/i), '2026-11');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(Object.keys(onAdd.mock.calls[0][0])).not.toContain('focusDate');
  });

  it('bounds the day picker to the two ends of the month above it', async () => {
    // The browser refusing a day outside the month is what keeps the invariant
    // `readingPrefix` depends on; the submit guard is the same rule for a
    // browser that degrades this to a text box. November has thirty days and
    // the bound is asked of the calendar, not of a table of twelve numbers.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    const day = screen.getByLabelText(/^day/i);
    expect(day).toBeDisabled();

    await user.type(screen.getByLabelText(/departure month/i), '2026-11');
    expect(day).toBeEnabled();
    expect(day).toHaveAttribute('min', '2026-11-01');
    expect(day).toHaveAttribute('max', '2026-11-30');
  });

  it('lets go of a day when the month moves out from under it', async () => {
    /*
     * The one state the invariant cannot survive, and a silent one: a date
     * control shows `09/11/2026` the same way whichever month is picked above
     * it. Cleared rather than shifted into the new month — the 9th of November
     * is not evidence about December.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderEditor();

    await user.type(screen.getByLabelText(/departure month/i), '2026-11');
    await user.type(screen.getByLabelText(/^day/i), '2026-11-09');
    expect(screen.getByLabelText(/^day/i)).toHaveValue('2026-11-09');

    await user.clear(screen.getByLabelText(/departure month/i));
    await user.type(screen.getByLabelText(/departure month/i), '2026-12');
    expect(screen.getByLabelText(/^day/i)).toHaveValue('');
  });

  it('says a day has gone rather than adding a focus nothing can collect', async () => {
    // A day inside a month that is still half ahead of us, but behind today.
    // It would be refused by the collector on every pass forever, and the
    // reader has no way to learn that the day was the problem.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.type(screen.getByLabelText(/departure month/i), '2026-08');
    await user.type(screen.getByLabelText(/^day/i), '2026-08-03');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('That day has gone.');
  });

  it('has no return field at all, rather than one that is ignored', () => {
    // 12.113: a month of departures has no single return date to share, and a
    // control the collector would silently drop is worse than no control.
    renderEditor();
    expect(screen.queryByLabelText(/return/i)).not.toBeInTheDocument();
  });

  it('will not add a month the calendar has finished with', async () => {
    /*
     * Two guards, and this proves both ends of the outcome rather than one of
     * the mechanisms. `min` on the control is what a browser enforces — which
     * is why no `role="alert"` appears here, the submit event never fires —
     * and the check inside `submit` is what catches the same value where
     * `type="month"` is not supported and degrades to a text box.
     */
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.type(screen.getByLabelText(/departure month/i), '2026-07');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByLabelText(/departure month/i)).toHaveAttribute('min', '2026-08');
  });

  it('says which field is wrong rather than letting the route vanish', async () => {
    // A route that disappears on save looks like a broken button, and the
    // reader has no way to learn that the month was the problem.
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent('Departure month must be a real month.');
  });
});
