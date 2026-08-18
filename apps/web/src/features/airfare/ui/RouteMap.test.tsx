import { render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RouteGeometry } from '@/features/airfare/lib/geo';
import { RouteMap } from '@/features/airfare/ui/RouteMap';

/**
 * jsdom gives this component no canvas — `getContext` returns null and the
 * globe never paints. That is the point of the split: the sphere and the land
 * live on a canvas nobody can test, and the *routes* live in the DOM, where
 * these assertions and a screen reader can both reach them.
 *
 * A map built on a tile renderer would fail every test below, because its
 * entire output is one opaque canvas element.
 */

beforeEach(() => {
  // jsdom has no canvas, and left alone it logs a "Not implemented" error on
  // every mount — noise that would drown the failure this suite is meant to
  // report. Returning null is honest: the component already treats a missing
  // context as nothing to paint. Same stub `CandleChart.test.tsx` uses.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

const LIM_CUZ: RouteGeometry = {
  id: 'LIM-CUZ-2026-10-17',
  origin: 'LIM',
  destination: 'CUZ',
  from: [-77.114444, -12.021944],
  to: [-71.938889, -13.535833],
  fromCity: 'Lima',
  toCity: 'Cusco',
};

const LIM_MAD: RouteGeometry = {
  id: 'LIM-MAD-2026-10-17',
  origin: 'LIM',
  destination: 'MAD',
  from: [-77.114444, -12.021944],
  to: [-3.567222, 40.498333],
  fromCity: 'Lima',
  toCity: 'Madrid',
};

function renderMap(overrides: Partial<React.ComponentProps<typeof RouteMap>> = {}) {
  const props = {
    routes: [LIM_CUZ, LIM_MAD],
    selectedId: null,
    onSelect: vi.fn(),
    tones: new Map<string, string>(),
    projection: 'globe' as const,
    onProjectionChange: vi.fn(),
    ...overrides,
  };
  return { ...render(<RouteMap {...props} />), props };
}

describe('RouteMap', () => {
  it('renders one reachable item per watched route', () => {
    renderMap();
    const list = screen.getByRole('list', { name: /watched routes/i });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
  });

  it('names each route by its cities rather than its codes', () => {
    // The arc is the only thing on this map carrying meaning, so it is the one
    // thing that has to say what it is out loud.
    renderMap();
    expect(screen.getByLabelText('Lima to Cusco')).toBeInTheDocument();
    expect(screen.getByLabelText('Lima to Madrid')).toBeInTheDocument();
  });

  it('offers both projections and says which is showing', () => {
    renderMap();
    expect(screen.getByRole('button', { name: 'Globe' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Mercator' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('asks for the other projection when the other button is pressed', () => {
    const { props } = renderMap();
    screen.getByRole('button', { name: 'Mercator' }).click();
    expect(props.onProjectionChange).toHaveBeenCalledWith('mercator');
  });

  it('draws the same routes flat', () => {
    renderMap({ projection: 'mercator' });
    expect(screen.getByLabelText('Lima to Madrid')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mercator' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('survives having nothing to draw', () => {
    // A watchlist whose routes have never been collected has no coordinates
    // yet, and an empty map is a normal state rather than a broken one.
    renderMap({ routes: [] });
    expect(within(screen.getByRole('list')).queryAllByRole('listitem')).toHaveLength(0);
  });

  it('does not crash without a canvas context', () => {
    // jsdom's `getContext` returns null. The component has to treat that as
    // "nothing to paint" rather than throwing, or every test on this page
    // would fail on a detail none of them are about.
    expect(() => renderMap()).not.toThrow();
  });
});
