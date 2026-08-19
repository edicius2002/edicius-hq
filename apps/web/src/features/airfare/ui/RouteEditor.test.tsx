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

  it('takes the two ends and the date and hands over a route', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const { onAdd } = renderEditor();

    await user.type(screen.getByRole('combobox', { name: /destination/i }), 'mad');
    await user.type(screen.getByLabelText(/departure/i), '2026-11-14');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'LIM', destination: 'MAD', flightDate: '2026-11-14' }),
    );
  });
});
