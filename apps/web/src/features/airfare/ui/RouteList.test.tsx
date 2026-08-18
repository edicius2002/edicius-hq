import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { FareRoute } from '@/features/airfare/data/fareRoutes';
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
    selectedId: null,
    today: TODAY,
    onSelect: vi.fn(),
    onRemove: vi.fn(),
    onAdd: vi.fn(),
    ...overrides,
  };
  return { ...render(<RouteList {...props} />), props };
}

describe('RouteList', () => {
  it('lists the watched routes', () => {
    renderList();
    expect(screen.getByText('LIM → CUZ')).toBeInTheDocument();
    expect(screen.getByText('LIM → SCL')).toBeInTheDocument();
  });

  it('marks a route whose departure has passed', () => {
    // Its history stays — that is what an archive is for — but nothing more
    // will be collected, and the reader should not have to work out why the
    // series stopped.
    renderList();
    expect(screen.getByText('Departed')).toBeInTheDocument();
  });

  it('keeps the add form folded away until it is asked for', () => {
    // A five-field form is not something anyone needs in view while reading
    // prices, and open by default it took as much room as the list itself.
    renderList();
    expect(screen.queryByRole('form', { name: /add a route/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /watch another route/i })).toBeInTheDocument();
  });

  it('opens the form in place of its own trigger', async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole('button', { name: /watch another route/i }));

    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
    // Replaced rather than pushed down, so the panel does not jump.
    expect(screen.queryByRole('button', { name: /watch another route/i })).not.toBeInTheDocument();
  });

  it('closes the form again on cancel, adding nothing', async () => {
    const user = userEvent.setup();
    const { props } = renderList();
    await user.click(screen.getByRole('button', { name: /watch another route/i }));
    await user.click(screen.getByRole('button', { name: /cancel/i }));

    expect(screen.queryByRole('form', { name: /add a route/i })).not.toBeInTheDocument();
    expect(props.onAdd).not.toHaveBeenCalled();
  });

  it('adds a route and folds the form away again', async () => {
    const user = userEvent.setup();
    const { props } = renderList();
    await user.click(screen.getByRole('button', { name: /watch another route/i }));

    await user.clear(screen.getByLabelText('Origin'));
    await user.type(screen.getByLabelText('Origin'), 'LIM');
    await user.type(screen.getByLabelText('Destination'), 'MAD');
    // The date input takes a value rather than keystrokes; typing into it is
    // locale-dependent and this assertion is not about the date picker.
    const departure = screen.getByLabelText('Departure');
    await user.clear(departure);
    await user.type(departure, '2026-12-01');
    await user.click(screen.getByRole('button', { name: /watch route/i }));

    expect(props.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'LIM', destination: 'MAD', flightDate: '2026-12-01' }),
    );
    expect(screen.queryByRole('form', { name: /add a route/i })).not.toBeInTheDocument();
  });

  it('still offers the form when nothing is watched yet', () => {
    renderList({ routes: [] });
    expect(screen.getByText(/no routes watched yet/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /watch another route/i })).toBeInTheDocument();
  });
});
