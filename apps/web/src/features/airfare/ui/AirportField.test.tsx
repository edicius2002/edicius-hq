import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AirportField } from '@/features/airfare/ui/AirportField';

/**
 * The server is stubbed here rather than reached — an unstubbed `fetch`
 * rejects in this suite by design, and what is being tested is the field, not
 * the ranking. The ranking has its own tests, in Python, against the real
 * table.
 */

const MATCHES = [
  { code: 'MAD', city: 'Madrid', country: 'Spain', name: 'Adolfo Suárez Madrid–Barajas' },
  { code: 'MDE', city: 'Medellín', country: 'Colombia', name: 'José María Córdova' },
];

function stubSearch(matches = MATCHES) {
  const fetchMock = vi.fn(() => Promise.resolve(Response.json({ query: 'mad', matches })));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/**
 * Mounts empty and then sets the value, because that is what typing looks like
 * from the component's side — and because a value that is simply *there* on
 * mount deliberately does not search. The origin field starts pre-filled, and
 * popping a suggestion list open over the map before anyone has typed is not
 * what a suggestion list is for.
 */
function renderField(value = '', onChange = vi.fn()) {
  const view = render(
    <AirportField id="test-origin" label="Origin" value="" onChange={onChange} />,
  );
  if (value) {
    view.rerender(
      <AirportField id="test-origin" label="Origin" value={value} onChange={onChange} />,
    );
  }
  return { ...view, onChange };
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AirportField', () => {
  it('asks for nothing until there is something worth asking about', async () => {
    // A list that appears before it can mean anything gets dismissed, and then
    // ignored when it finally does mean something.
    const fetchMock = stubSearch();
    renderField('M');
    await vi.advanceTimersByTimeAsync(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('offers what the server found, with the place and not just the code', async () => {
    stubSearch();
    renderField('MAD');
    await vi.advanceTimersByTimeAsync(400);

    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());
    expect(screen.getByText('Madrid, Spain')).toBeInTheDocument();
    expect(screen.getByText('Medellín, Colombia')).toBeInTheDocument();
  });

  it('waits for typing to settle instead of asking on every keystroke', async () => {
    const fetchMock = stubSearch();
    const { rerender } = renderField('MA');
    rerender(<AirportField id="test-origin" label="Origin" value="MAD" onChange={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(400);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not search a value that was simply there when it mounted', async () => {
    // The origin field arrives pre-filled with the default airport. Searching
    // for it on mount opened a list over the map before anyone had typed.
    const fetchMock = stubSearch();
    render(<AirportField id="test-origin" label="Origin" value="LIM" onChange={vi.fn()} />);
    await vi.advanceTimersByTimeAsync(400);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('takes a suggestion with the keyboard', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubSearch();
    const { onChange } = renderField('MAD');
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{ArrowDown}{Enter}');

    expect(onChange).toHaveBeenCalledWith('MDE');
  });

  it('follows the highlight for a screen reader', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubSearch();
    renderField('MAD');
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    const box = screen.getByRole('combobox');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    const first = box.getAttribute('aria-activedescendant');
    await user.click(box);
    await user.keyboard('{ArrowDown}');
    expect(box.getAttribute('aria-activedescendant')).not.toBe(first);
  });

  it('dismisses the list on Escape without changing the value', async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    stubSearch();
    const { onChange } = renderField('MAD');
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() => expect(screen.getByRole('listbox')).toBeInTheDocument());

    await user.click(screen.getByRole('combobox'));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('keeps working when the lookup fails', async () => {
    // The table is a convenience; the collector is the authority. A code the
    // server could not look up still has to be typeable.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    renderField('MAD');
    await vi.advanceTimersByTimeAsync(400);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox')).toHaveValue('MAD');
  });

  it('says nothing when the server found nothing', async () => {
    stubSearch([]);
    renderField('ZZZ');
    await vi.advanceTimersByTimeAsync(400);

    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });
});
