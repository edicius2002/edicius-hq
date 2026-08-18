import { fireEvent, render, screen } from '@testing-library/react';
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
    onMove: vi.fn(),
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

  it('keeps the fields on screen rather than behind a control', () => {
    // Adding a route is what this panel is for. A form that has to be opened
    // first puts a step in front of the only action here.
    renderList();
    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
    expect(screen.getByLabelText('Origin')).toBeInTheDocument();
    expect(screen.getByLabelText('Return (optional)')).toBeInTheDocument();
  });

  it('adds a route from the fields', async () => {
    const user = userEvent.setup();
    const { props } = renderList();

    await user.clear(screen.getByLabelText('Origin'));
    await user.type(screen.getByLabelText('Origin'), 'LIM');
    await user.type(screen.getByLabelText('Destination'), 'MAD');
    const departure = screen.getByLabelText('Departure');
    await user.clear(departure);
    await user.type(departure, '2026-12-01');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(props.onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'LIM', destination: 'MAD', flightDate: '2026-12-01' }),
    );
  });

  it('suggests the airports already collected without demanding one of them', async () => {
    // A shortcut, never a gate. The archive learns an airport the first time a
    // route through it is collected, so this list starts tiny — and a code it
    // has never heard of has to stay watchable.
    const user = userEvent.setup();
    const { props, container } = renderList({
      airports: [
        {
          code: 'CUZ',
          name: 'Alejandro Velasco Astete',
          city: 'Cusco',
          country: 'Peru',
          latitude: -13.5,
          longitude: -71.9,
        },
      ],
    });

    expect(container.querySelector('datalist option[value="CUZ"]')).not.toBeNull();
    expect(screen.getByLabelText('Origin')).toHaveAttribute('list', 'airfare-known-airports');

    await user.type(screen.getByLabelText('Destination'), 'MAD');
    const departure = screen.getByLabelText('Departure');
    await user.clear(departure);
    await user.type(departure, '2026-12-01');
    await user.click(screen.getByRole('button', { name: /add route/i }));

    expect(props.onAdd).toHaveBeenCalledWith(expect.objectContaining({ destination: 'MAD' }));
  });

  it('lets a route be dragged to another position', () => {
    // Order is not decoration on this list: the collector spends its daily
    // request budget down it, so dragging to the top is a statement about
    // which route matters when the budget will not cover everything.
    const { props } = renderList();
    const rows = screen.getAllByRole('listitem');

    fireEvent.dragStart(rows[1]);
    fireEvent.drop(rows[0]);

    expect(props.onMove).toHaveBeenCalledWith('LIM|SCL|2026-08-01|', 'LIM|CUZ|2026-10-17|');
  });

  it('reorders from the keyboard too', async () => {
    // Neither list this mechanism came from could be reordered without a
    // mouse. That is fixed in the shared hook, and asserted where it is used.
    const user = userEvent.setup();
    const { props } = renderList();

    // The label is a span; the focusable thing is the row's own button.
    screen.getByText('LIM → SCL').closest('button')!.focus();
    await user.keyboard('{Alt>}{ArrowUp}{/Alt}');

    expect(props.onMove).toHaveBeenCalledWith('LIM|SCL|2026-08-01|', 'LIM|CUZ|2026-10-17|');
  });

  it('still offers the fields when nothing is watched yet', () => {
    renderList({ routes: [] });
    expect(screen.getByText(/no routes watched yet/i)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: /add a route/i })).toBeInTheDocument();
  });
});
